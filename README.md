# MyWhisperApp

A web-based speech-to-text transcription service powered by [Faster Whisper XXL](https://github.com/Purfview/whisper-standalone-win). Upload audio files through a simple browser interface and receive transcriptions in SRT or plain text format.

## Features

- Drag & drop file upload
- Real-time progress tracking
- Download results as `.srt` (subtitles) or `.txt` (plain text)
- Background job processing (non-blocking)
- Works on company intranet

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
├── MyWhisperApp.exe
├── wwwroot/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── whisper/                      ← Create this folder if necessary
    ├── faster-whisper-xxl.exe    ← Copy from downloaded release
    └── ... (all other files from the release)
```

Copy the **entire contents** of the Faster Whisper XXL release into the `publish/whisper/` folder.

### 3. Run the Application

Double-click `MyWhisperApp.exe` or run from command line:

```bash
cd publish
MyWhisperApp.exe
```

### 4. Open in Browser

Navigate to: **http://localhost:5162**

---

## Network Access (Intranet)

To make the application accessible to other computers on your network:

### Option A: Command Line

```bash
MyWhisperApp.exe --urls "http://0.0.0.0:5162"
```

### Option B: Environment Variable

Set `ASPNETCORE_URLS` before running:

```bash
set ASPNETCORE_URLS=http://0.0.0.0:5162
MyWhisperApp.exe
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
sc create WhisperService binPath="C:\WhisperApp\MyWhisperApp.exe --urls http://0.0.0.0:5162" start=auto
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

When running as a service, console output goes to the Windows Event Log:
- Open Event Viewer (`eventvwr.msc`)
- Navigate to: Windows Logs → Application
- Filter by source: WhisperService

---

## Folder Structure

```
MyWhisperApp/
├── publish/                    # Ready-to-run application
│   ├── MyWhisperApp.exe
│   ├── wwwroot/
│   └── whisper/                # Add Faster Whisper here
├── wwwroot/                    # Frontend source files
│   ├── index.html
│   ├── app.js
│   └── style.css
├── uploads/                    # Temporary upload directory (auto-created)
├── whisper/                    # Development: Faster Whisper location
├── Program.cs                  # Backend source code
├── MyWhisperApp.csproj
└── README.md
```

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

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 5162 | HTTP port for the web server |
| Whisper Model | medium | Accuracy vs speed trade-off |
| Output Format | srt | Subtitle format |

### Whisper Model Options

Edit in `Program.cs` (the `-m` argument):

| Model | Speed | Accuracy | VRAM |
|-------|-------|----------|------|
| tiny | Fastest | Low | ~1 GB |
| base | Fast | Medium | ~1 GB |
| small | Medium | Good | ~2 GB |
| medium | Slow | High | ~5 GB |
| large-v2 | Slowest | Highest | ~10 GB |

---

## Troubleshooting

### "Das System kann die angegebene Datei nicht finden"
The `whisper/faster-whisper-xxl.exe` is missing. Make sure you copied Faster Whisper into the correct folder.

### First run is slow
Whisper downloads the model on first use. This can take a few minutes depending on model size and internet speed.

### Windows SmartScreen warning
On first run, Windows may block the executable. Run faster-whisper-xxl manually and click "More info" → "Run anyway".

### Port already in use
Another application is using port 5162. Either stop that application or use a different port:
```bash
MyWhisperApp.exe --urls "http://0.0.0.0:8080"
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Redirects to index.html |
| POST | `/api/upload` | Upload audio file, returns job ID |
| GET | `/api/status/{jobId}` | Get job status and results |

### Example: Upload via curl

```bash
curl -X POST -F "file=@audio.wav" http://localhost:5162/api/upload
# Returns: {"jobId": "abc123", "status": "queued"}

curl http://localhost:5162/api/status/abc123
# Returns: {"status": "complete", "transcription": "...", ...}
```

---

## Tech Stack

- **Backend:** ASP.NET Core (.NET 10, Minimal API)
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **Transcription:** Faster Whisper XXL (standalone)
- **Icons:** Google Material Icons

---

## TODO

- [x] Run as Windows Service
- [ ] Load Whisper parameters from config file
- [ ] Support multiple concurrent transcriptions
- [ ] Add language selection dropdown
- [ ] Authentication for intranet deployment

---

## License

This project is provided as-is for internal use.

Faster Whisper XXL has its own license - see: https://github.com/Purfview/whisper-standalone-win
