using Serilog;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// One line in stats/job-stats.jsonl, written once per finished job.
/// Deliberately contains no file names and no transcript content.
/// </summary>
record JobStatRecord
{
    public string JobId { get; init; } = "";
    public string Status { get; init; } = "";
    public string FileExtension { get; init; } = "";
    public long FileSizeBytes { get; init; }
    public DateTimeOffset QueuedAt { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset FinishedAt { get; init; }

    /// <summary>Decoded audio length as reported by ffmpeg; null if normalization is disabled or ffmpeg reported nothing usable.</summary>
    public double? AudioSeconds { get; init; }

    public bool HadWarnings { get; init; }

    [JsonIgnore] public double QueueWaitSeconds => (StartedAt - QueuedAt).TotalSeconds;
    [JsonIgnore] public double ProcessingSeconds => (FinishedAt - StartedAt).TotalSeconds;

    public static JobStatRecord FromJob(TranscriptionJob job, DateTimeOffset finishedAt) => new()
    {
        JobId = job.Id,
        Status = job.Status,
        FileExtension = Path.GetExtension(job.FileName).ToLowerInvariant(),
        FileSizeBytes = job.FileSizeBytes,
        QueuedAt = job.QueuedAt,
        StartedAt = job.StartedAt ?? job.QueuedAt,
        FinishedAt = finishedAt,
        AudioSeconds = job.AudioDuration?.TotalSeconds,
        HadWarnings = !string.IsNullOrEmpty(job.Warnings),
    };
}

record StatsSummary(
    int Jobs,
    int Completed,
    int Failed,
    int CompletedWithWarnings,
    double TotalAudioHours,
    TimeSpan? AverageAudioLength,
    TimeSpan? LongestAudio,
    double TotalProcessingHours,
    TimeSpan? AverageProcessingTime,
    double? RealtimeFactor,
    TimeSpan? AverageQueueWait,
    TimeSpan? LongestQueueWait
);

record DayStats(DateOnly Date, int Jobs, int Failed, double AudioMinutes, double ProcessingMinutes);

record RecentStats(int Days, StatsSummary Summary, IReadOnlyList<DayStats> PerDay);

record AnalyticsReport(DateTimeOffset? TrackingSince, StatsSummary AllTime, RecentStats Recent);

/// <summary>
/// Append-only JSON Lines file plus an in-memory copy for fast aggregation.
/// Independent of the Serilog configuration and its log retention.
/// </summary>
sealed class JobStatsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly string _filePath;
    private readonly List<JobStatRecord> _records = [];
    private readonly object _lock = new();

    public JobStatsStore(string filePath)
    {
        _filePath = filePath;
        Load();
    }

    private void Load()
    {
        if (!File.Exists(_filePath))
        {
            return;
        }

        var skipped = 0;
        foreach (var line in File.ReadLines(_filePath))
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            try
            {
                if (JsonSerializer.Deserialize<JobStatRecord>(line, JsonOptions) is { } record)
                {
                    _records.Add(record);
                }
            }
            catch (JsonException)
            {
                // e.g. a line cut off by a power loss mid-write; losing one job is acceptable
                skipped++;
            }
        }

        Log.Information("Loaded {Count} job statistics records from {File}", _records.Count, _filePath);
        if (skipped > 0)
        {
            Log.Warning("Skipped {Skipped} unreadable lines in {File}", skipped, _filePath);
        }
    }

    public void Add(JobStatRecord record)
    {
        var line = JsonSerializer.Serialize(record, JsonOptions) + Environment.NewLine;

        lock (_lock)
        {
            // In-memory first: if the disk write fails, statistics since restart stay correct
            _records.Add(record);
            Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
            File.AppendAllText(_filePath, line);
        }
    }

    public AnalyticsReport GetAnalytics(int recentDays)
    {
        JobStatRecord[] all;
        lock (_lock)
        {
            all = [.. _records];
        }

        var today = DateOnly.FromDateTime(DateTime.Now);
        var firstDay = today.AddDays(-(recentDays - 1));
        var recent = all.Where(r => LocalDay(r) >= firstDay).ToArray();

        return new AnalyticsReport(
            TrackingSince: all.Length > 0 ? all.Min(r => r.QueuedAt) : null,
            AllTime: Summarize(all),
            Recent: new RecentStats(recentDays, Summarize(recent), PerDay(recent, firstDay, today))
        );
    }

    private static StatsSummary Summarize(IReadOnlyCollection<JobStatRecord> records)
    {
        var completed = records.Where(r => r.Status == JobStatus.Complete).ToArray();
        var completedWithAudio = completed.Where(r => r.AudioSeconds > 0).ToArray();

        var totalAudioSeconds = completedWithAudio.Sum(r => r.AudioSeconds!.Value);

        // Ratio of sums rather than mean of ratios: short files carry a fixed overhead
        // (model loading) that would otherwise dominate the average
        double? realtimeFactor = totalAudioSeconds > 0
            ? Math.Round(completedWithAudio.Sum(r => r.ProcessingSeconds) / totalAudioSeconds, 2)
            : null;

        return new StatsSummary(
            Jobs: records.Count,
            Completed: completed.Length,
            Failed: records.Count(r => r.Status == JobStatus.Error),
            CompletedWithWarnings: completed.Count(r => r.HadWarnings),
            TotalAudioHours: Math.Round(totalAudioSeconds / 3600, 2),
            AverageAudioLength: Average(completedWithAudio.Select(r => r.AudioSeconds!.Value)),
            LongestAudio: Max(completedWithAudio.Select(r => r.AudioSeconds!.Value)),
            TotalProcessingHours: Math.Round(completed.Sum(r => r.ProcessingSeconds) / 3600, 2),
            AverageProcessingTime: Average(completed.Select(r => r.ProcessingSeconds)),
            RealtimeFactor: realtimeFactor,
            AverageQueueWait: Average(records.Select(r => r.QueueWaitSeconds)),
            LongestQueueWait: Max(records.Select(r => r.QueueWaitSeconds))
        );
    }

    private static List<DayStats> PerDay(IEnumerable<JobStatRecord> records, DateOnly firstDay, DateOnly lastDay)
    {
        var byDay = records.ToLookup(LocalDay);

        var days = new List<DayStats>();
        for (var day = firstDay; day <= lastDay; day = day.AddDays(1))
        {
            var dayRecords = byDay[day].ToArray();
            var completed = dayRecords.Where(r => r.Status == JobStatus.Complete).ToArray();

            days.Add(new DayStats(
                Date: day,
                Jobs: dayRecords.Length,
                Failed: dayRecords.Count(r => r.Status == JobStatus.Error),
                AudioMinutes: Math.Round(completed.Sum(r => r.AudioSeconds ?? 0) / 60, 1),
                ProcessingMinutes: Math.Round(completed.Sum(r => r.ProcessingSeconds) / 60, 1)));
        }
        return days;
    }

    // Group by the server's local calendar day of submission, which is what users think in
    private static DateOnly LocalDay(JobStatRecord r) => DateOnly.FromDateTime(r.QueuedAt.LocalDateTime);

    private static TimeSpan? Average(IEnumerable<double> seconds)
    {
        var values = seconds.ToArray();
        return values.Length > 0 ? ToRoundedTimeSpan(values.Average()) : null;
    }

    private static TimeSpan? Max(IEnumerable<double> seconds)
    {
        var values = seconds.ToArray();
        return values.Length > 0 ? ToRoundedTimeSpan(values.Max()) : null;
    }

    private static TimeSpan ToRoundedTimeSpan(double seconds) => TimeSpan.FromSeconds(Math.Round(seconds));
}
