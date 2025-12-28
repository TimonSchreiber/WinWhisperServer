using System.Text.RegularExpressions;

var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

SemaphoreSlim whisperSemaphore = new(1, 1);

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
    await whisperSemaphore.WaitAsync();

    try
    {
        var form = await request.ReadFormAsync();
        var file = form.Files["file"];
        if (file is null || file.Length == 0)
        {
            return Results.BadRequest(new { error = "No file uploaded." });
        }

        // Create uploads directory if it doesn't exist
        var uploadsRoot = Path.Combine(app.Environment.ContentRootPath, "uploads");
        Directory.CreateDirectory(uploadsRoot);

        // Create unique directory for this request
        var requestId = Guid.NewGuid().ToString("N");
        var requestDir = Path.Combine(uploadsRoot, requestId);
        Directory.CreateDirectory(requestDir);

        // Save the uplaoded file
        var savedFilePath = Path.Combine(requestDir, file.FileName);
        await using (var fs = new FileStream(savedFilePath, FileMode.Create))
        {
            await file.CopyToAsync(fs);
        }

        // Process file
        WhisperResult? result = null;
        string? srtContent = null;

        try
        {
            result = await ProcessFileAsync(app.Environment.ContentRootPath, savedFilePath);
            // Check if transcription succeeded
            if (result.ExitCode != 0)
            {
                return Results.Problem(
                    detail: $"Whisper failed: {result.Error}",
                    statusCode: 500
                );
            }

            // The .srt file should be in the same directory as the input file
            var srtFileName = Path.GetFileNameWithoutExtension(file.FileName) + ".srt";
            var srtPath = Path.Combine(requestDir, srtFileName);

            if (!File.Exists(srtPath))
            {
                return Results.Problem(
                    detail: $"SRT file not found. Whisper output: {result.Output}",
                    statusCode: 500
                );
            }

            // Read the SRT content
            srtContent = await File.ReadAllTextAsync(srtPath);

            return Results.Ok(new
            {
                message = "Transcription complete.",
                fileName = file.FileName,
                transcription = srtContent,
                plainText = SrtToPlainText(srtContent)
            });
        }
        finally
        {
            try
            {
                Directory.Delete(requestDir, recursive: true);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to delete {requestDir}: {ex.Message}");
            }
        }
    }
    finally
    {
        whisperSemaphore.Release();
    }
})
.DisableAntiforgery();

app.Run();

// =============================================================================
// PROCESSING LOGIC
// =============================================================================

static async Task<WhisperResult> ProcessFileAsync(string contentRootPath, string filePath)
{
    var exePath = Path.Combine(contentRootPath, "whisper", "faster-whisper-xxl.exe");
    var uploadsDir = Path.GetDirectoryName(filePath);

    Console.WriteLine($"Running Whisper on: {Path.GetFileName(filePath)}");

    var process = new System.Diagnostics.Process
    {
        StartInfo =
        {
            FileName = exePath,
            Arguments = $"\"{filePath}\" -o source -f srt -m medium",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = contentRootPath,
        }
    };

    process.Start();

    var output = await process.StandardOutput.ReadToEndAsync();
    var error = await process.StandardError.ReadToEndAsync();
    await process.WaitForExitAsync();

    Console.WriteLine($"Whisper exit code: {process.ExitCode}");
    Console.WriteLine($"Whisper output: {output}");
    if (!string.IsNullOrEmpty(error))
    {
        Console.WriteLine($"Whisper error: {error}");
    }

    return new WhisperResult
    {
        ExitCode = process.ExitCode,
        Output = output,
        Error = error,
    };
}

static string SrtToPlainText(string str)
{
    return MyRegex().Replace(str, "");
}

// Simple record to hold the result
record WhisperResult
{
    public int ExitCode { get; init; }
    public string Output { get; init; } = "";
    public string Error { get; init; } = "";
}

partial class Program
{
    [GeneratedRegex("\r?\n?\\d+\r?\n.+? --> .+?\r?\n", RegexOptions.Multiline)]
    private static partial Regex MyRegex();
}