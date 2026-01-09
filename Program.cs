using System.Collections.Concurrent;
using System.Text.RegularExpressions;

var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

SemaphoreSlim whisperSemaphore = new(1, 1);

ConcurrentDictionary<string, TranscriptionJob> jobs = new();

string uploadsRoot = Path.Combine(app.Environment.ContentRootPath, "uploads");

const int CompletedJobRetentionMinutes = 1; // TODO: increase time when in development

CleanUpOrphanedJobs();

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

    // Save the uplaoded file
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

    // start background processing
    _ = Task.Run(async () =>
    {
        await ProcessJobAsync(job, app.Environment.ContentRootPath, savedFilePath);
    });

    // Return immediately with job ID
    return Results.Ok(new { jobId, status = "queued" });
})
.DisableAntiforgery();

app.MapGet("/api/status/{jobId}", (string jobId) =>
{
    if (!jobs.TryGetValue(jobId, out var job))
    {
        return Results.NotFound(new { error = "Job not found" });
    }

    return Results.Ok(new
    {
        jobId = job.Id,
        fileName = job.FileName,
        status = job.Status,
        progress = job.Progress,
        transcription = job.SrtContent,
        plainText = job.PlainText,
        error = job.Error
    });
});

app.Run();

// =============================================================================
// PROCESSING LOGIC
// =============================================================================

async Task ProcessJobAsync(TranscriptionJob job, string contentRootPath, string filePath)
{
    try
    {
        // Wait for semaphore (queued if another job is running)
        job.Status = "queued";
        await whisperSemaphore.WaitAsync();

        try
        {
            job.Status = "processing";
            job.Progress = 0;

            var exePath = Path.Combine(contentRootPath, "whisper", "faster-whisper-xxl.exe");

            Console.WriteLine($"[{job.Id}] Starting Whisper on: {job.FileName}");

            var process = new System.Diagnostics.Process
            {
                StartInfo =
                {
                    FileName = exePath,
                    Arguments = $"\"{filePath}\" -pp -o source -f srt -m medium",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = contentRootPath,
                }
            };

            process.Start();

            // Read sdtout in real time for progress updates
            var outputtask = Task.Run(async () =>
            {
                while (true)
                {
                    var line = await process.StandardOutput.ReadLineAsync();
                    if (line == null)
                    {
                        break;
                    }
                    // Parse progress of present
                    var match = ProgressPercentageRegex().Match(line);
                    if (match.Success && int.TryParse(match.Groups[1].Value, out var pct))
                    {
                        job.Progress = pct;
                    }
                }
            });

            await outputtask;
            await process.WaitForExitAsync();

            Console.WriteLine($"[{job.Id}] Whisper exit code: {process.ExitCode}");

            if (process.ExitCode != 0)
            {
                job.Status = "error";
                job.Error = $"Whisper exited with code {process.ExitCode}";
                return;
            }

            // Read SRT file
            var srtPath = Path.Combine(job.RequestDir, Path.GetFileNameWithoutExtension(job.FileName) + ".srt");
            if (!File.Exists(srtPath))
            {
                job.Status = "error";
                job.Error = "SRT file not found after processing";
                return;
            }

            job.SrtContent = await File.ReadAllTextAsync(srtPath);
            job.PlainText = SrtToPlainText(job.SrtContent);
            job.Progress = 100;
            job.Status = "complete";

            Console.WriteLine($"[{job.Id}] Transcription complete");
        }
        finally
        {
            whisperSemaphore.Release();
        }
    }
    catch (Exception ex)
    {
        job.Status = "error";
        job.Error = ex.Message;
        Console.WriteLine($"[{job.Id}] Error: {ex.Message}");
    }
    finally
    {
        // Clean up files after a delay (give time for download)
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromMinutes(CompletedJobRetentionMinutes));
            try
            {
                Directory.Delete(job.RequestDir, recursive: true);
                jobs.TryRemove(job.Id, out _);
                Console.WriteLine($"[{job.Id}] Cleaned up");
            }
            catch { }
        });
    }
}

void CleanUpOrphanedJobs()
{
    if (Directory.Exists(uploadsRoot))
    {
        var cutoff = DateTime.UtcNow.AddMinutes(-CompletedJobRetentionMinutes);
        foreach (var dir in Directory.GetDirectories(uploadsRoot))
        {
            try
            {
                var created = Directory.GetCreationTimeUtc(dir);
                if (created < cutoff)
                {
                    Directory.Delete(dir, recursive: true);
                    Console.WriteLine($"Startup cleanup: deleted orphaned directory {Path.GetFileName(dir)}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Startup cleanup failed for {dir}: {ex.Message}");
            }
        }
    }
}

static string SrtToPlainText(string str)
{
    return SrtTimeStampLineRegex().Replace(str, "");
}

record TranscriptionJob
{
    public string Id { get; init; } = "";
    public string FileName { get; init; } = "";
    public string Status { get; set; } = "queued";
    public int Progress { get; set; } = 0;
    public string? SrtContent { get; set; }
    public string? PlainText { get; set; }
    public string? Error { get; set; }
    public string RequestDir { get; set; } = "";
}

partial class Program
{

    [GeneratedRegex(@"^\s*(\d+)%")]
    private static partial Regex ProgressPercentageRegex();

    [GeneratedRegex(@"\r?\n?\d+\r?\n.+? --> .+?\r?\n", RegexOptions.Multiline)]
    private static partial Regex SrtTimeStampLineRegex();
}
