using Serilog;
using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;

// Read configuration from appsettings.json
var config = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
    .Build();

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(config)
    .CreateLogger();

try
{
    Log.Information("WinWhisperServer starting...");

    var builder = WebApplication.CreateBuilder(args);

    builder.Host.UseSerilog();

    // Run as Windows Service
    builder.Host.UseWindowsService();

    // Bind settings from appsettings.json
    var whisperSettings = builder.Configuration.GetSection("Whisper").Get<WhisperSettings>() ?? new WhisperSettings();
    var jobSettings = builder.Configuration.GetSection("Jobs").Get<JobSettings>() ?? new JobSettings();
    var uploadSettings = builder.Configuration.GetSection("Upload").Get<UploadSettings>() ?? new UploadSettings();

    // Translate User specified upload size from MB to Bytes. Windows effectively uses MiB anyway. Interprets bigger values like 1000 MB as 1 GiB
    var maxBytes = uploadSettings.MaxFileSizeMB * (int)Math.Pow(1_024, 2 + Math.Floor(Math.Log(uploadSettings.MaxFileSizeMB, 1_000)));

    // Normalize allowed extensions to lowercase and ensure they start with a dot
    var allowedExtensions = uploadSettings.AllowedExtensions
        .Select(ext => ext.Trim().ToLowerInvariant())
        .Where(ext => ext.Length > 0)
        .Select(ext => ext.StartsWith('.') ? ext : "." + ext)
        .ToHashSet();

    // Set upload size limit (default is 30MiB)
    builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
    {
        options.MultipartBodyLengthLimit = maxBytes;
    });

    builder.WebHost.ConfigureKestrel(options =>
    {
        options.Limits.MaxRequestBodySize = maxBytes;
    });

    var app = builder.Build();

    // Job storage
    ConcurrentDictionary<string, TranscriptionJob> jobs = new();

    // FIFO queue using Channel
    var jobChannel = Channel.CreateUnbounded<string>();

    // Queue position tracking
    List<string> jobQueue = [];
    object queueLock = new();

    var contentRootPath = app.Environment.ContentRootPath;
    var uploadsRoot = Path.Combine(contentRootPath, "uploads");

    // Usage statistics, persisted independently of the log files and their retention
    var serverStartedAt = DateTimeOffset.Now;
    var jobStats = new JobStatsStore(Path.Combine(contentRootPath, "stats", "job-stats.jsonl"));

    // Clean up orphaned jobs from previous runs
    CleanUpOrphanedJobs();

    // Start background workers (one per MaxConcurrent)
    for (int i = 0; i < jobSettings.MaxConcurrent; i++)
    {
        var workerId = i + 1;
        _ = Task.Run(async () =>
        {
            Log.Information("Worker {WorkerId} Started", workerId);
            await ProcessJobsFromChannel(workerId);
        });
    }

    // Serve static files from wwwroot
    app.UseDefaultFiles();
    app.UseStaticFiles();

    // =============================================================================
    // YOUR API ENDPOINTS
    // =============================================================================

    // File upload endpoint
    app.MapPost("/api/upload", async (HttpRequest request) =>
    {
        var form = await request.ReadFormAsync();
        var file = form.Files["file"];
        if (file is null || file.Length == 0)
        {
            return Results.BadRequest(new { error = "No file uploaded." });
        }

        // The name comes from the client, so it may contain a path ("../../x") or characters that would
        // break the quoted ffmpeg/whisper arguments. Only the cleaned name is used from here on.
        var fileName = SanitizeFileName(file.FileName);

        // Check extension against allowed list
        if (allowedExtensions.Count > 0)
        {
            var ext = Path.GetExtension(fileName).ToLowerInvariant();
            if (!allowedExtensions.Contains(ext))
            {
                return Results.BadRequest(new
                {
                    error = $"File type '{ext}' is not allowed. Allowed: {string.Join(", ", allowedExtensions)}"
                });
            }
        }

        // Create unique directory for this request
        Directory.CreateDirectory(uploadsRoot);

        var jobId = Guid.NewGuid().ToString("N");
        var requestDir = Path.Combine(uploadsRoot, jobId);
        Directory.CreateDirectory(requestDir);

        // Save the uploaded file
        var savedFilePath = Path.Combine(requestDir, fileName);
        await using (var fs = new FileStream(savedFilePath, FileMode.Create))
        {
            await file.CopyToAsync(fs);
        }

        // Create job entry
        var job = new TranscriptionJob
        {
            Id = jobId,
            FileName = fileName,
            FileSizeBytes = file.Length,
            Status = JobStatus.Queued,
            RequestDir = requestDir
        };
        jobs[jobId] = job;

        // Add to queue for position tracking
        lock (queueLock)
        {
            jobQueue.Add(jobId);
        }

        // Queue for processing
        await jobChannel.Writer.WriteAsync(jobId);

        // Get initial queue position
        int queuePosition;
        lock(queueLock)
        {
            queuePosition = jobQueue.IndexOf(jobId);
        }

        JobLog.For(JobEvents.JobQueued, jobId)
              .Information("Job queued at position {QueuePosition}", queuePosition);

        return Results.Ok(new { jobId, status = JobStatus.Queued, queuePosition });
    })
    .DisableAntiforgery();

    app.MapGet("/api/status/{jobId}", (string jobId) =>
    {
        if (!jobs.TryGetValue(jobId, out var job))
        {
            return Results.NotFound(new { error = "Job not found" });
        }

        int queuePosition;
        lock (queueLock)
        {
            queuePosition = jobQueue.IndexOf(jobId);
        }

        return Results.Ok(new
        {
            jobId = job.Id,
            fileName = job.FileName,
            status = job.Status,
            progress = job.Progress,
            queuePosition,
            duration = job.Duration,
            outputs = job.Outputs,
            error = job.Error,
            warnings = job.Warnings
        });
    });

    app.MapGet("/api/settings", () =>
    {
        return Results.Ok(new
        {
            maxFileSizeMB = uploadSettings.MaxFileSizeMB,
            outputFormats = whisperSettings.OutputFormats,
            allowedExtensions
        });
    });

    app.MapGet("/api/analytics", (int? days) =>
    {
        var recentDays = Math.Clamp(days ?? 30, 1, 366);
        var report = jobStats.GetAnalytics(recentDays);
        var activeJobs = jobs.Values;

        return Results.Ok(new
        {
            generatedAt = DateTimeOffset.Now,
            serverStartedAt,
            current = new
            {
                queued = activeJobs.Count(j => j.Status == JobStatus.Queued),
                processing = activeJobs.Count(j => j.Status == JobStatus.Processing),
            },
            trackingSince = report.TrackingSince,
            allTime = report.AllTime,
            recent = report.Recent,
        });
    });

    app.Run();

    Log.Information("WinWhisperServer stopped");

    // =============================================================================
    // BACKGROUND WORKER
    // =============================================================================

    async Task ProcessJobsFromChannel(int workerId)
    {
        await foreach (var jobId in jobChannel.Reader.ReadAllAsync())
        {
            if (!jobs.TryGetValue(jobId, out var job))
            {
                Log.Warning("Worker {WorkerId} dequeued unknown Job {JobId}", workerId, jobId);
                continue;
            }

            JobLog.For(JobEvents.JobStarted, jobId)
                  .Information("Job processing started");

            var filePath = Path.Combine(job.RequestDir, job.FileName);
            await ProcessJobAsync(job, filePath);
        }
    }

    // =============================================================================
    // PROCESSING LOGIC
    // =============================================================================

    async Task ProcessJobAsync(TranscriptionJob job, string filePath)
    {
        try
        {
            job.StartedAt = DateTimeOffset.Now;
            job.Status = JobStatus.Processing;

            var exePath = Path.Combine(contentRootPath, whisperSettings.ExecutablePath);

            // Normalize audio if enabled
            var fileToTranscribe = filePath;
            if (whisperSettings.NormalizeAudio)
            {
                var ffmpegExe = Path.Combine(Path.GetDirectoryName(exePath)!, "ffmpeg.exe");
                var normalizedPath = Path.Combine(
                    job.RequestDir,
                    $"normalized_{Path.GetFileNameWithoutExtension(filePath)}.{whisperSettings.NormalizeOutputExtension}"
                );

                var ffmpegArgs = whisperSettings.FfmpegArguments
                    .Replace("{input}", filePath)
                    .Replace("{output}", normalizedPath);

                JobLog.For(JobEvents.Normalize, job.Id)
                      .Information("Normalizing audio with ffmpeg");

                var ffmpeg = new System.Diagnostics.Process
                {
                    StartInfo = {
                        FileName = ffmpegExe,
                        Arguments = ffmpegArgs,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WorkingDirectory = contentRootPath,
                    }
                };

                ffmpeg.Start();
                var ffmpegStderr = await ffmpeg.StandardError.ReadToEndAsync();
                await ffmpeg.WaitForExitAsync();

                job.AudioDuration = ParseFfmpegAudioDuration(ffmpegStderr);

                if (ffmpeg.ExitCode == 0 && File.Exists(normalizedPath))
                {
                    JobLog.For(JobEvents.Normalize, job.Id)
                          .Information("ffmpeg normalization successful");
                    fileToTranscribe = normalizedPath;
                }
                else
                {
                    JobLog.For(JobEvents.Normalize, job.Id)
                          .Warning(
                            "ffmpeg normalization failed (exit {ExitCode}), proceeding with original. ffmpeg output: {FfmpegOutput}",
                            ffmpeg.ExitCode,
                            ffmpegStderr
                          );
                }
            }

            var argsBuilder = new StringBuilder();
            argsBuilder.Append($"\"{fileToTranscribe}\" -pp -o source");
            argsBuilder.Append($" -f {string.Join(" ", whisperSettings.OutputFormats)}");
            argsBuilder.Append($" -m {whisperSettings.Model}");

            if (!string.IsNullOrEmpty(whisperSettings.Language))
            {
                argsBuilder.Append($" -l {whisperSettings.Language}");
            }

            if (!string.IsNullOrEmpty(whisperSettings.AdditionalArguments))
            {
                argsBuilder.Append($" {whisperSettings.AdditionalArguments}");
            }

            var process = new System.Diagnostics.Process
            {
                StartInfo = {
                    FileName = exePath,
                    Arguments = argsBuilder.ToString(),
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = contentRootPath,
                }
            };

            process.Start();

            // Read stdout for progress updates and job duration
            var outputTask = Task.Run(async () =>
            {
                while (true)
                {
                    var line = await process.StandardOutput.ReadLineAsync();
                    if (line == null)
                    {
                        break;
                    }

                    // Parse progress if present
                    var progressMatch = ProgressPercentageRegex().Match(line);
                    if (progressMatch.Success && int.TryParse(progressMatch.Groups[1].Value, out var pct))
                    {
                        job.Progress = pct;
                    }

                    // Parse job duration if present
                    var durationMatch = TranscriptionDurationRegex().Match(line);
                    if (durationMatch.Success)
                    {
                        job.Duration = durationMatch.Groups[1].Value;
                    }
                }
            });

            // Read stderr for any error messages
            var stderrBuilder = new StringBuilder();
            var errorTask = Task.Run(async () =>
            {
                while (true)
                {
                    var line = await process.StandardError.ReadLineAsync();
                    if (line == null)
                    {
                        break;
                    }
                    if (!string.IsNullOrWhiteSpace(line))
                    {
                        stderrBuilder.AppendLine(line);
                    }
                }
            });

            await Task.WhenAll(outputTask, errorTask);
            await process.WaitForExitAsync();

            if (process.ExitCode != 0)
            {
                job.Status = JobStatus.Error;
                job.Error = $"Whisper exited with code {process.ExitCode}";
                JobLog.For(JobEvents.JobFailed, job.Id)
                      .Error("Job failed with exit code {ExitCode}", process.ExitCode);
                return;
            }

            // Collect any stderr output as warning if job succeeded but there were messages
            var stderrOutput = stderrBuilder.ToString().Trim();
            if (!string.IsNullOrEmpty(stderrOutput))
            {
                job.Warnings = stderrOutput;
                JobLog.For(JobEvents.WhisperStderr, job.Id)
                      .Warning("Whisper stderr output: {Warnings}", stderrOutput);
            }

            // Read all output files
            job.Outputs = [];
            var baseFileName = Path.GetFileNameWithoutExtension(fileToTranscribe);

            foreach (var format in whisperSettings.OutputFormats)
            {
                var outputPath = Path.Combine(job.RequestDir, $"{baseFileName}.{format}");
                if (File.Exists(outputPath))
                {
                    job.Outputs[format] = await File.ReadAllTextAsync(outputPath);
                }
            }

            if (job.Outputs.Count == 0)
            {
                job.Status = JobStatus.Error;
                job.Error = "No output files found after processing";
                return;
            }

            job.Progress = 100;
            job.Status = JobStatus.Complete;

            JobLog.For(JobEvents.JobCompleted, job.Id)
                  .Information("Job completed successfully in {Duration}", job.Duration);
        }
        catch (Exception ex)
        {
            job.Status = JobStatus.Error;
            job.Error = ex.Message;
            JobLog.For(JobEvents.JobFailed, job.Id)
                  .Error(ex, "job failed");
        }
        finally
        {
            // Remove from queue tracking
            lock (queueLock)
            {
                jobQueue.Remove(job.Id);
            }

            // Record usage statistics; a failure here must never affect the job itself
            try
            {
                jobStats.Add(JobStatRecord.FromJob(job, DateTimeOffset.Now));
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "Failed to record statistics for job {JobId}", job.Id);
            }

            // Clean up files after a delay
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromMinutes(jobSettings.CompletedJobRetentionMinutes));
                try
                {
                    Directory.Delete(job.RequestDir, recursive: true);
                    jobs.TryRemove(job.Id, out _);
                    JobLog.For(JobEvents.JobCleanedUp, job.Id)
                          .Debug("Temporary files deleted");
                }
                catch { }
            });

            JobLog.For(JobEvents.JobSummary, job.Id)
                  .Information(
                    "Job finished with status {Status} in {Duration}, outputs: {OutputFormats}, warnings: {Warnings}",
                    job.Status,
                    job.Duration,
                    job.Outputs?.Keys,
                    job.Warnings
                  );
        }
    }

    void CleanUpOrphanedJobs()
    {
        if (Directory.Exists(uploadsRoot))
        {
            var cutoff = DateTime.UtcNow.AddMinutes(-jobSettings.OrphanedMaxAgeMinutes);
            foreach (var dir in Directory.GetDirectories(uploadsRoot))
            {
                try
                {
                    var created = Directory.GetCreationTimeUtc(dir);
                    if (created < cutoff)
                    {
                        Directory.Delete(dir, recursive: true);
                    }
                }
                catch (Exception ex)
                {
                    Log.Error(
                        ex,
                        "Failed to clean up orphaned job directory {Directory}",
                        dir
                    );
                }
            }
        }
    }
}
catch (Exception ex)
{
    Log.Fatal(ex, "Application crashed");
}
finally
{
    Log.CloseAndFlush();
}

record TranscriptionJob
{
    public string Id { get; init; } = "";
    public string FileName { get; init; } = "";
    public string Status { get; set; } = JobStatus.Queued;
    public int? Progress { get; set; } = null;
    public string? Duration { get; set; }
    public Dictionary<string, string>? Outputs { get; set; }
    public string? Error { get; set; }
    public string? Warnings { get; set; }
    public string RequestDir { get; set; } = "";
    public long FileSizeBytes { get; init; }
    public DateTimeOffset QueuedAt { get; init; } = DateTimeOffset.Now;
    public DateTimeOffset? StartedAt { get; set; }
    public TimeSpan? AudioDuration { get; set; }
}

record WhisperSettings
{
    public string ExecutablePath { get; set; } = "whisper/faster-whisper-xxl.exe";
    public string Model { get; set; } = "medium";
    public string Language { get; set; } = "";
    public string AdditionalArguments { get; set; } = "";
    public string[] OutputFormats { get; set; } = [];
    public bool NormalizeAudio { get; set; } = true;
    public string NormalizeOutputExtension { get; set; } = "wav";
    public string FfmpegArguments { get; set; } = "-y -i \"{input}\" -ar 16000 -ac 1 \"{output}\"";
}

record JobSettings
{
    public int MaxConcurrent { get; set; } = 1;
    public int CompletedJobRetentionMinutes { get; set; } = 10;
    public int OrphanedMaxAgeMinutes { get; set; } = 30;
}

record UploadSettings
{
    public int MaxFileSizeMB { get; set; } = 30;
    public string[] AllowedExtensions { get; set; } = [];
}

partial class Program
{

    [GeneratedRegex(@"^\s*(\d+)%")]
    private static partial Regex ProgressPercentageRegex();

    [GeneratedRegex(@"Operation finished in:\s+(\d:\d{2}:\d{2}\.\d{3})")]
    private static partial Regex TranscriptionDurationRegex();

    // ffmpeg progress lines ("size=... time=00:01:23.45 bitrate=..."); the last one is the decoded length
    [GeneratedRegex(@"time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")]
    private static partial Regex FfmpegProgressTimeRegex();

    // Input header ("Duration: 00:01:23.45, start: ..."); only a fallback, since malformed headers
    // are exactly what NormalizeAudio exists to work around
    [GeneratedRegex(@"Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")]
    private static partial Regex FfmpegHeaderDurationRegex();

    // Characters Windows rejects in file names, applied on every OS so behaviour doesn't depend on where it runs
    private static readonly HashSet<char> InvalidFileNameChars =
        [.. Path.GetInvalidFileNameChars(), '"', '<', '>', '|', ':', '*', '?'];

    private static string SanitizeFileName(string clientFileName)
    {
        // Path.GetFileName only knows the current OS's separator, so normalize both first
        var name = Path.GetFileName(clientFileName.Replace('\\', '/'));
        var cleaned = new string([.. name.Select(c => InvalidFileNameChars.Contains(c) || char.IsControl(c) ? '_' : c)])
            .Trim(' ', '.');
        return cleaned.Length > 0 ? cleaned : "upload";
    }

    private static TimeSpan? ParseFfmpegAudioDuration(string ffmpegOutput)
    {
        var progressMatches = FfmpegProgressTimeRegex().Matches(ffmpegOutput);
        var match = progressMatches.Count > 0
            ? progressMatches[^1]
            : FfmpegHeaderDurationRegex().Match(ffmpegOutput);

        if (!match.Success)
        {
            return null;
        }

        return TimeSpan.FromHours(int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture))
             + TimeSpan.FromMinutes(int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture))
             + TimeSpan.FromSeconds(double.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture));
    }
}

partial class JobLog
{
    public static Serilog.ILogger For(string eventType, string jobId)
        => Log.ForContext("EventType", eventType)
              .ForContext("JobId", jobId);
}

partial class JobStatus
{
    public const string Queued      = "queued";
    public const string Processing  = "processing";
    public const string Complete    = "complete";
    public const string Error       = "error";
}

partial class JobEvents
{
    public const string JobQueued     = "JobQueued";
    public const string JobStarted    = "JobStarted";
    public const string JobCompleted  = "JobCompleted";
    public const string JobFailed     = "JobFailed";
    public const string JobCleanedUp  = "JobCleanedUp";
    public const string JobSummary    = "JobSummary";
    public const string Normalize     = "Normalize";
    public const string WhisperStderr = "WhisperStderr";
}
