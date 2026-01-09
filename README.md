# MyWhisperApp:

## Create self contained EXE:
`dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o ./publish`


## Copy content of /publish/

**For distribution**:
```

/publish
├── WhisperBackend.exe      (your app)
├── wwwroot/                (copy this folder next to exe)
│   ├── index.html
│   ├── app.js
│   └── style.css
└── whisper/                (copy this folder next to exe)
    └── faster-whisper-xxl.exe (and its dependencies)
```

## Set URL via command line
`dotnet run --urls "http://0.0.0.0:5162"`

## Check ASP.NET Version:
- `dotnet --version`
- `dotnet --list-sdks`
- `dotnet --list-runtimes`


## TODO:
- Als Windows Server Dienst starten?
- Whisper Parameter als dynamisch als Env-Datei
