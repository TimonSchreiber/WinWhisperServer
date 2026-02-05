using Serilog;
using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;

// Read confifuration from appsettings.json
var config = new ConfigurationBuilder()
    .SetBasePath(Directory.GetCurrentDirectory())
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

    // Set upload size limit (default is 30MiB)
    builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(options =>
    {
        options.MultipartBodyLengthLimit = maxBytes;
    });

    builder.WebHost.ConfigureKestrel(options =>
    {
        options.Limits.MaxRequestBodySize = maxBytes;
    });

    // Apply default if no formats configured
    if (whisperSettings.OutputFormats.Length == 0)
    {
        whisperSettings.OutputFormats = ["json", "srt"];
    }

    var app = builder.Build();

    // Job storage
    ConcurrentDictionary<string, TranscriptionJob> jobs = new();

    // FIFO queue using Channel
    var jobChannel = Channel.CreateUnbounded<string>();

    // Queue position tracking
    List<string> jobQueue = [];
    object queueLock = new();

    var uploadsRoot = Path.Combine(app.Environment.ContentRootPath, "uploads");

    // Clean up orphaned jobs from previous runs
    CleanUpOrphanedJobs(uploadsRoot, jobSettings.OrphanedMaxAgeMinutes);

    // Start background workers (one per MaxConcurrent)
    for (int i = 0; i < jobSettings.MaxConcurrent; i++)
    {
        var workerId = i + 1;
        _ = Task.Run(async () =>
        {
            Log.Information($"Worker {workerId} Started");
            await ProcessJobsFromChannel(workerId);
        });
    }

    // Serve static files from wwwroot folder (for index.html, css, js, etc.)
    app.UseStaticFiles();

    // Redirect root "/" to index.html
    app.MapGet("/", () => Results.Redirect("/index.html"));

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

        // Create unique directory for this request
        Directory.CreateDirectory(uploadsRoot);

        var jobId = Guid.NewGuid().ToString("N");
        var requestDir = Path.Combine(uploadsRoot, jobId);
        Directory.CreateDirectory(requestDir);

        // Save the uploaded file
        var savedFilePath = Path.Combine(requestDir, file.FileName);
        await using (var fs = new FileStream(savedFilePath, FileMode.Create))
        {
            await file.CopyToAsync(fs);
        }

        // Create job entry
        var job = new TranscriptionJob
        {
            Id = jobId,
            FileName = file.FileName,
            Status = "queued",
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

        Log.Information($"[{jobId}] Queued at position {queuePosition}");

        // Return immediately with job ID
        return Results.Ok(new { jobId, status = "queued", queuePosition  });
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
            error = job.Error
        });
    });

    app.MapGet("/api/settings", () =>
    {
        return Results.Ok(new
        {
            maxFileSizeMB = uploadSettings.MaxFileSizeMB,
            outputFormats = whisperSettings.OutputFormats
        });
    });

    app.Run();

    // =============================================================================
    // BACKGROUND WORKER
    // =============================================================================

    async Task ProcessJobsFromChannel(int workerId)
    {
        await foreach (var jobId in jobChannel.Reader.ReadAllAsync())
        {
            if (!jobs.TryGetValue(jobId, out var job))
            {
                Log.Information($"[Worker {workerId}] Job {jobId} not found, skipping");
                continue;
            }

            Log.Information($"[Worker {workerId}] Processing job {jobId}");

            var filePath = Path.Combine(job.RequestDir, job.FileName);
            await ProcessJobAsync(job, app.Environment.ContentRootPath, filePath);
        }
    }

    // =============================================================================
    // PROCESSING LOGIC
    // =============================================================================

    async Task ProcessJobAsync(TranscriptionJob job, string contentRootPath, string filePath)
    {
        try
        {
            job.Status = "processing";

            var exePath = Path.Combine(contentRootPath, whisperSettings.ExecutablePath);

            var argsBuilder = new StringBuilder();
            argsBuilder.Append($"\"{filePath}\" -pp -o source");
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

            Log.Information($"[{job.Id}] Starting Whisper on: {job.FileName}");

            var process = new System.Diagnostics.Process
            {
                StartInfo =
                {
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

            // Read stdout in real time for progress updates
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

                    // Parse duration if present
                    var durationMatch = TranscriptionDurationRegex().Match(line);
                    if (durationMatch.Success)
                    {
                        job.Duration = durationMatch.Groups[1].Value;
                    }
                }
            });

            await outputTask;
            await process.WaitForExitAsync();

            Log.Information($"[{job.Id}] Whisper exit code: {process.ExitCode}");

            if (process.ExitCode != 0)
            {
                job.Status = "error";
                job.Error = $"Whisper exited with code {process.ExitCode}";
                return;
            }

            // Read all output files
            job.Outputs = [];
            var baseFileName = Path.GetFileNameWithoutExtension(job.FileName);

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
                job.Status = "error";
                job.Error = "No output files not found after processing";
                return;
            }

            job.Progress = 100;
            job.Status = "complete";

            Log.Information($"[{job.Id}] Transcription complete in {job.Duration}");
        }
        catch (Exception ex)
        {
            job.Status = "error";
            job.Error = ex.Message;
            Log.Error($"[{job.Id}] Error: {ex.Message}");
        }
        finally
        {
            // Remove from queue tracking
            lock (queueLock)
            {
                jobQueue.Remove(job.Id);
            }

            // Clean up files after a delay
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromMinutes(jobSettings.CompletedJobRetentionMinutes));
                try
                {
                    Directory.Delete(job.RequestDir, recursive: true);
                    jobs.TryRemove(job.Id, out _);
                    Log.Information($"[{job.Id}] Cleaned up");
                }
                catch { }
            });
        }
    }

    void CleanUpOrphanedJobs(string uploadsRoot, int orphanedMaxAgeMinutes)
    {
        if (Directory.Exists(uploadsRoot))
        {
            var cutoff = DateTime.UtcNow.AddMinutes(-orphanedMaxAgeMinutes);
            foreach (var dir in Directory.GetDirectories(uploadsRoot))
            {
                try
                {
                    var created = Directory.GetCreationTimeUtc(dir);
                    if (created < cutoff)
                    {
                        Directory.Delete(dir, recursive: true);
                        Log.Information($"Startup cleanup: deleted orphaned directory {Path.GetFileName(dir)}");
                    }
                }
                catch (Exception ex)
                {
                    Log.Warning($"Startup cleanup failed for {dir}: {ex.Message}");
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
    public string Status { get; set; } = "queued";
    public int? Progress { get; set; } = null;
    public string? Duration { get; set; }
    public Dictionary<string, string>? Outputs { get; set; }
    public string? Error { get; set; }
    public string RequestDir { get; set; } = "";
}

record WhisperSettings
{
    public string ExecutablePath { get; set; } = "whisper/faster-whisper-xxl.exe";
    public string Model { get; set; } = "medium";
    public string Language { get; set; } = "";
    public string AdditionalArguments { get; set; } = "";

    public string[] OutputFormats { get; set; } = [];
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
}

partial class Program
{

    [GeneratedRegex(@"^\s*(\d+)%")]
    private static partial Regex ProgressPercentageRegex();

    [GeneratedRegex(@"Operation finished in:\s+(\d:\d{2}:\d{2}\.\d{3})")]
    private static partial Regex TranscriptionDurationRegex();
}
