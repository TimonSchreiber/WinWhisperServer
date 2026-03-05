# WinWhisperServer

A Windows web server for speech-to-text transcription, powered by [Faster Whisper XXL](https://github.com/Purfview/whisper-standalone-win). Upload audio files through a simple browser interface and receive transcriptions in multiple format.

## Features

- Drag & drop file upload
- Real-time progress tracking
- Download results in multiple formats (SRT, TXT, JSON, VTT, LRC, TSV, TEXT)
- Background job processing with FIFO queue
- Audio normalization to fix broken/malformed audio files before transcription
- Warnings when the audio processor reports issues with a file
- Can run as Windows Service

---

## Quick Start (No Installation Required)

For users who just want to run the application without installing .NET SDK.

### 1. Download Faster Whisper XXL

Download the latest release from:
https://github.com/Purfview/whisper-standalone-win/releases

Extract it and note the location.

### 2. Set Up the Application

```
publish/
├── WinWhisperServer.exe
├── wwwroot/
│   ├── index.html
│   ├── app.js
│   └── style.css
│   ├── material-icons.css
│   └── fonts/
│       └── material-icons.woff2
└── whisper/                      ← Create this folder if necessary
    ├── faster-whisper-xxl.exe    ← Copy from downloaded release
    └── ... (all other files from the release)
```

Copy the **entire contents** of the Faster Whisper XXL release into the `/whisper` folder.

### 3. Run the Application

Double-click `WinWhisperServer.exe` or run from command line:

```bash
cd publish
WinWhisperServer.exe
```

### 4. Open in Browser

Navigate to: **http://localhost:5162**

---

## Network Access (Intranet)

To make the application accessible to other computers on your network:

### Option A: Command Line

```bash
WinWhisperServer.exe --urls "http://0.0.0.0:5162"
```

### Option B: Environment Variable

Set `ASPNETCORE_URLS` before running:

```bash
set ASPNETCORE_URLS=http://0.0.0.0:5162
WinWhisperServer.exe
```

### Firewall

Make sure Windows Firewall allows incoming connections on port 5162.

Users on your network can then access the app at:
`http://<server-ip>:5162`
(e.g., `http://192.168.1.50:5162`)

---

## Running as Windows Service

For production deployment, you can install the application as a Windows Service that starts automatically with Windows.

### Install (Run Command Prompt as Administrator)
```bash
sc create WhisperService binPath="C:\WhisperApp\WinWhisperServer.exe --urls http://0.0.0.0:5162" start=auto
sc start WhisperService
```

Replace `C:\WhisperApp\` with your actual installation path.

### Manage the Service
```bash
sc stop WhisperService       # Stop the service
sc start WhisperService      # Start the service
sc delete WhisperService     # Uninstall completely
```

Or use the Services GUI: Press `Win+R`, type `services.msc`, find "WhisperService".

### View Logs

When running as a service, logs are written to the `logs/` folder and optionally to the Windows Event Log (see Logging section).

---

## Folder Structure

```
WinWhisperServer/
├── publish/                    # Ready-to-run application
│   ├── WinWhisperServer.exe
│   ├── wwwroot/
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── style.css
│   │   ├── material-icons.css
│   │   └── fonts/
│   │       └── material-icons.woff2
│   └── whisper/                # Add Faster Whisper here
├── wwwroot/                    # Frontend source files
├── uploads/                    # Temporary upload directory (auto-created)
├── whisper/                    # Development: Faster Whisper location
├── Program.cs                  # Backend source code
├── appsettings.json            # Config file
├── WinWhisperServer.csproj
└── README.md
```

---

## Configuration

Edit `appsettings.json` to customize:
```json
{
  "Whisper": {
    "ExecutablePath": "whisper/faster-whisper-xxl.exe",
    "Model": "medium",
    "Language": "",
    "AdditionalArguments": "",
    "OutputFormats": ["json", "srt"],
    "NormalizeAudio": true,
    "NormalizeOutputExtension": "wav",
    "FfmpegArguments": "-y -i \"{input}\" -ar 16000 -ac 1 \"{output}\""
  },
  "Jobs": {
    "MaxConcurrent": 1,
    "CompletedJobRetentionMinutes": 10,
    "OrphanedMaxAgeMinutes": 30
  },
  "Upload": {
    "MaxFileSizeMB": 30
  }
}
```

| Setting | Description |
|---------|-------------|
| `Model` | tiny, base, small, medium, large-v2 |
| `Language` | Empty for auto-detect, or: en, de, fr, etc. |
| `MaxConcurrent` | Number of parallel transcriptions |
| `OutputFormats` | List of formats to generate: srt, txt, json, vtt, lrc, tsv, text |
| `NormalizeAudio` | Re-process audio through ffmpeg before transcription. Fixes broken headers from some recording devices. Default: true |
| `NormalizeOutputExtension` | Output format for normalized audio. Only change this if you also change `FfmpegArguments` to produce a different format. Default: wav |
| `FfmpegArguments` | ffmpeg command arguments. `{input}` and `{output}` are replaced at runtime. Default re-encodes to 16kHz mono WAV, which is Whisper's native format |
| `MaxFileSizeMB` | Maximum upload size in MB. Default: 30 |
| `CompletedJobRetentionMinutes` | How long to keep job results available after completion. Default: 10 |
| `OrphanedMaxAgeMinutes` | On startup, delete upload directories older than this. Default: 30 |

### Whisper Model Options

| Model | Speed | Accuracy | VRAM |
|-------|-------|----------|------|
| tiny | Fastest | Low | ~1 GB |
| base | Fast | Medium | ~1 GB |
| small | Medium | Good | ~2 GB |
| medium | Slow | High | ~5 GB |
| large-v2 | Slowest | Highest | ~10 GB |

---

## Logging

WinWhisperServer uses Serilog for structured logging with multiple output destinations.

### Initial Setup (EventLog)

To enable Windows Event Log logging, register the source once (requires Administrator PowerShell):
```powershell
New-EventLog -LogName Application -Source "WinWhisperServer"
```

### Configuration

Configure logging in `appsettings.json`:
```json
{
  "Serilog": {
    "Using": [
      "Serilog.Sinks.File",
      "Serilog.Sinks.EventLog",
      "Serilog.Expressions"
    ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft": "Warning"
      }
    },
    "WriteTo": [
      {
        "Name": "File",
        "Args": {
          "path": "logs/general-.log",
          "rollingInterval": "Day",
          "retainedFileCountLimit": 14
        }
      }
    ]
  }
}
```

### Log Destinations

| Sink | Location | Default Content |
|------|----------|-----------------|
| File (general) | `logs/general-.log` | All application logs |
| File (jobs) | `logs/jobs-.log` | Job events only (optional) |
| EventLog | Event Viewer → Application | Configurable (optional) |
| Console | Terminal window | Not enabled by default |

### Event Types

Job-related logs include an `EventType` property for filtering:

| EventType | Description |
|-----------|-------------|
| `JobQueued` | File uploaded and queued |
| `JobStarted` | Processing began |
| `JobCompleted` | Transcription finished successfully |
| `JobFailed` | Transcription failed |
| `JobCleanedUp` | Temporary files deleted |
| `JobSummary` | Final status summary including duration and output formats |
| `Normalize` | ffmpeg normalization step (success or failure) |
| `WhisperStderr` | Raw stderr output from faster-whisper-xxl, if any |

### Advanced: Filtered Logging

To write specific events to separate destinations, use sub-loggers:
```json
{
  "Name": "Logger",
  "Args": {
    "configureLogger": {
      "Filter": [
        {
          "Name": "ByIncludingOnly",
          "Args": {
            "expression": "@Properties['EventType'] like 'Job%'"
          }
        }
      ],
      "WriteTo": [
        {
          "Name": "File",
          "Args": {
            "path": "logs/jobs-.log",
            "rollingInterval": "Day"
          }
        }
      ]
    }
  }
}
```

### Enable Console Logging

For interactive debugging, add to the `Using` and `WriteTo` arrays:
```json
{
  "Serilog": {
    "Using": [
      "Serilog.Sinks.Console",
      ...
    ],
    "WriteTo": [
      { "Name": "Console" },
      ...
    ]
  }
}
```

### View Logs

- **File logs:** Check the `logs/` folder
- **Event Viewer:** `Win+R` → `eventvwr.msc` → Windows Logs → Application → Filter by "WinWhisperServer"

---

## Development Setup

For developers who want to modify the application.

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download) (or current version used)
- Faster Whisper XXL in `/whisper` folder

### Run in Development Mode
```bash
dotnet run
```

Access at: http://localhost:5162

### Build Self-Contained Executable
```bash
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ./publish
```

This creates a standalone `.exe` that includes the .NET runtime. Users don't need .NET installed.

### Release Script

The `scripts/publish-release.ps1` script automates testing and publishing:
```powershell
# First time only: allow local scripts
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Create release with smoke tests
./scripts/publish-release.ps1 -Version "1.8.0"

# Create release with ZIP for GitHub
./scripts/publish-release.ps1 -Version "1.8.0" -CreateZip

# Skip tests (not recommended)
./scripts/publish-release.ps1 -Version "1.8.0" -SkipTests
```

The script:
- Runs smoke tests (normal startup + Windows Service simulation)
- Publishes a clean build
- Creates an empty `whisper/` placeholder
- Optionally creates a release ZIP

---

## Troubleshooting

### "Das System kann die angegebene Datei nicht finden"
The `whisper/faster-whisper-xxl.exe` is missing. Make sure you copied Faster Whisper into the correct folder.

## Transcription stops before the end of the file
Some voice recorders write malformed audio headers, causing faster-whisper to underestimate the file length and stop early. Enable `NormalizeAudio` in `appsettings.json` (default: true) to have ffmpeg re-encode the file before transcription, which resolves this. If the issue persists, the result panel will show a warning with technical details from the audio processor.

### First run is slow
Whisper downloads the model on first use. This can take a few minutes depending on model size and internet speed.

### Windows SmartScreen warning
On first run, Windows may block the executable. Run faster-whisper-xxl manually and click "More info" → "Run anyway".

### Port already in use
Another application is using port 5162. Either stop that application or use a different port:
```bash
WinWhisperServer.exe --urls "http://0.0.0.0:8080"
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Redirects to index.html |
| GET | `/api/status/{jobId}` | Get job status and results |
| GET | `/api/settings` | Returns configured output formats and upload limit |
| POST | `/api/upload` | Upload audio file, returns job ID |

### Example: Upload via curl

```bash
curl -X POST -F "file=@audio.wav" http://localhost:5162/api/upload
# Returns: {"jobId": "abc123", "status": "queued", "queuePosition": 0}

curl http://localhost:5162/api/status/abc123
# Returns: {"status": "complete", "outputs": {"srt": "...", "txt": "..."}, "duration": "0:00:42.000", "warnings": null, ...}
```

---

## Tech Stack

- **Backend:** ASP.NET Core (.NET 10, Minimal API)
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **Transcription:** Faster Whisper XXL (standalone)
- **Icons:** Material Icons (self-hosted, no external requests)

---

## License

This project is provided as-is for internal use.

Faster Whisper XXL has its own license - see: https://github.com/Purfview/whisper-standalone-win
