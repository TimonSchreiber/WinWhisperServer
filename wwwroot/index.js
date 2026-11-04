import { downloadFile, escapeHtml, showError } from '/shared/common.js';

// Global settings
let appSettings = {
  maxFileSizeMB: 30,
  outputFormats: ['json', 'srt'],
  allowedExtensions: [],
};

// DOM Elements
const fileInput = document.getElementById('fileInput');
const fileSelectArea = document.getElementById('fileSelectArea');
const transcribeBtn = document.getElementById('transcribeBtn');
const browseBtn = document.getElementById('browseBtn');
const fileNameDiv = document.getElementById('fileName');
const resultDiv = document.getElementById('result');

// A failure the server reported for this job, as opposed to a network problem
class JobFailedError extends Error {}

// Load settings from backend
async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      appSettings = { ...appSettings, ...(await response.json()) };
    }
  } catch (error) {
    console.warn('Could not load settings, using default values:', error);
  }
}

// Apply settings
function applySettings() {
  const exts = appSettings.allowedExtensions;
  if (exts?.length) {
    fileInput.accept = exts.join(',')
  }

  // else: keep the fallback accept from index.html, which allows common audio formats
}

// Check if the file extension is allowed
function isAllowedFile(file) {
  const exts = appSettings.allowedExtensions;
  if (!exts?.length) return true;
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  return exts.includes(ext);
}

// Show selected file info and enable transcribe button
function showSelectedFile(file) {
  // Check if the file type is allowed
  if (!isAllowedFile(file)) {
    fileNameDiv.innerHTML = `
      <div class="warning">
        <span class="material-icons" aria-hidden="true">warning</span>
        Unsupported file type. Allowed: ${escapeHtml(appSettings.allowedExtensions.join(', '))}
      </div>
    `;
    transcribeBtn.disabled = true;
    return;
  }

  // Display file name and size
  const sizeText = formatBytes(file.size);
  const fileSizeMB = file.size / (1024 * 1024);
  const limitMB = appSettings.maxFileSizeMB;

  // Warn if file is within 10% of limit
  const warningThreshold = limitMB * 0.9;
  const showWarning = fileSizeMB > warningThreshold;

  let warningHtml = showWarning ? `
      <div class="warning">
        <span class="material-icons" aria-hidden="true">warning</span>
        File might exceed upload limit of ${limitMB} MB
      </div>
    ` : '';

  fileNameDiv.innerHTML = `
    Selected file: <strong>${escapeHtml(file.name)}</strong> (${sizeText})
    ${warningHtml}
  `;

  transcribeBtn.disabled = false;
}

// Format bytes to human-readable string
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// Upload file and handle response
async function uploadFile() {
  const file = fileInput.files[0];
  if (!file) return;

  const fileSizeMB = file.size / (1024 * 1024);

  transcribeBtn.disabled = true;
  browseBtn.disabled = true;
  fileInput.disabled = true;
  fileSelectArea.classList.add('disabled');
  transcribeBtn.classList.add('loading');
  transcribeBtn.setAttribute('aria-busy', 'true');

  resultDiv.className = 'processing';
  resultDiv.innerHTML = `
    <span class="material-icons" aria-hidden="true">hourglass_empty</span>
    <strong>Uploading...</strong>
    ${progressBarHtml('0%')}
  `;

  const formData = new FormData();
  formData.append('file', file);

  try {
    // Upload and get job ID
    const uploadResponse = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    // Handle HTTP errors
    if (!uploadResponse.ok) {
      await handleHttpError(uploadResponse, fileSizeMB);
      return;
    }

    const uploadData = await uploadResponse.json();
    const jobId = uploadData.jobId;

    resultDiv.innerHTML = `
      <span class="material-icons" aria-hidden="true">hourglass_empty</span>
      <strong>Processing...</strong>
      ${progressBarHtml('Queued...')}
    `;

    resultDiv.scrollIntoView({ behavior: 'smooth' });

    // Poll for status
    const result = await pollForCompletion(jobId);
    showResult(result, file.name);
  } catch (error) {
    if (error instanceof TypeError && fileSizeMB > appSettings.maxFileSizeMB) {
      showError(
        resultDiv,
        'File Too Large',
        `Maximum allowed size is ${appSettings.maxFileSizeMB} MB. Your file is ${fileSizeMB.toFixed(1)} MB.`,
        'Try compressing the audio or splitting it into smaller parts.'
      );
      return;
    }
    handleNetworkError(error);
  } finally {
    transcribeBtn.disabled = false;
    browseBtn.disabled = false;
    fileInput.disabled = false;
    fileSelectArea.classList.remove('disabled');
    transcribeBtn.classList.remove('loading');
    transcribeBtn.removeAttribute('aria-busy');
  }
}

// Progress bar markup; the per-second text updates are kept out of screen reader announcements
function progressBarHtml(initialText) {
  return `
    <div class="progress-bar" id="progressBar" role="progressbar" aria-label="Progress"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="progress-fill" id="progressFill"></div>
    </div>
    <div id="progressText" aria-live="off">${initialText}</div>
  `;
}

// Poll the server for job completion
async function pollForCompletion(jobId) {
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  while (true) {
    const response = await fetch(`/api/status/${jobId}`);
    if (response.status === 404) {
      throw new JobFailedError('The server no longer knows this job, possibly because it was restarted.');
    }
    if (!response.ok) {
      throw new Error(`Status request failed with HTTP ${response.status}`);
    }
    const data = await response.json();

    switch (data.status) {
      case 'queued':
        progressText.textContent = `Queued... (${data.queuePosition} before you)`;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every second
        break;
      case 'processing':
        progressFill.style.width = `${data.progress ?? 0}%`;
        progressBar.setAttribute('aria-valuenow', String(data.progress ?? 0));
        progressText.textContent = data.progress == null
          ? 'Detecting Language...'
          : `Processing: ${data.progress}%`;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every second
        break;
      case 'complete':
        return data;
      case 'error':
        throw new JobFailedError(data.error || 'Processing failed');
      default:
        throw new Error(`Unknown status: ${data.status}`);
    }
  }
}

// Display the result and provide download options
function showResult(data, originalFileName) {
  const dot = originalFileName.lastIndexOf('.');
  const fileName = dot > 0 ? originalFileName.substring(0, dot) : originalFileName;
  const outputs = data.outputs || {};
  const formats = Object.keys(outputs);

  if (formats.length === 0) {
    resultDiv.className = 'error';
    resultDiv.innerHTML = `<span class="material-icons" aria-hidden="true">error</span> No output files received`;
    return;
  }

  const durationText = data.duration
    ? `<p>Completed in: <strong>${escapeHtml(data.duration)}</strong></p>`
    : '';

  const warningHtml = data.warnings
    ? `
      <div class="warning">
        <div>
          <span class="material-icons" aria-hidden="true">warning</span>
          <strong>Transcription may be incomplete.</strong>
          <p>The audio processor reported issues, likely with the audio file itself.
              Please review the result carefully, especially near the end.</p>
          <details>
            <summary>Technical details</summary>
            <pre>${escapeHtml(data.warnings)}</pre>
          </details>
        </div>
      </div>`
    : '';

  // Create download buttons for each format
  const downloadButtons = formats.map((format) =>
    `
      <button class="btn download-btn" data-format="${escapeHtml(format)}" data-filename="${escapeHtml(fileName)}">
        <span class="material-icons" aria-hidden="true">download</span> ${escapeHtml(fileName)}.${escapeHtml(format)}
      </button>
    `
  ).join('');

  // Preview: use order from settings, fallback to first available
  const previewFormat = appSettings.outputFormats.find((f) => formats.includes(f)) || formats[0];
  const previewContent = data.outputs[previewFormat];

  resultDiv.className = 'success';
  resultDiv.innerHTML = `
    <strong>
      <span class="material-icons" aria-hidden="true">check_circle</span> Transcription Complete!
    </strong>
    ${durationText}
    ${warningHtml}
    <div class="transcription-actions">
      ${downloadButtons}
    </div>
    <div class="transcription-preview">
      <strong>Preview (${escapeHtml(previewFormat)}):</strong>
      <pre>${escapeHtml(previewContent)}</pre>
    </div>
  `;

  // Attach download handlers dynamically
  document.querySelectorAll('.download-btn[data-format]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const format = btn.dataset.format;
      const name = btn.dataset.filename;
      const mimeTypes = {
        'json': 'application/json',
        'lrc' : 'text/plain',
        'txt' : 'text/plain',
        'text': 'text/plain',
        'vtt' : 'text/vtt',
        'srt' : 'application/x-subrip',
        'tsv' : 'text/tab-separated-values',
      };
      downloadFile(data.outputs[format], `${name}.${format}`, mimeTypes[format] || 'text/plain');
    });
  });
}

// File selection: the whole drop area is clickable, as its text says; the button inside handles itself
browseBtn.addEventListener('click', () => fileInput.click());
fileSelectArea.addEventListener('click', (event) => {
  if (event.target.closest('button') || fileSelectArea.classList.contains('disabled')) return;
  fileInput.click();
});
transcribeBtn.addEventListener('click', uploadFile);

fileInput.addEventListener('change', (event) => {
  if (event.target.files.length > 0) {
    showSelectedFile(event.target.files[0]);
  }
});

// Drag and drop
fileSelectArea.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (fileSelectArea.classList.contains('disabled')) return;
  fileSelectArea.classList.add('dragover');
});

fileSelectArea.addEventListener('dragleave', () => {
  fileSelectArea.classList.remove('dragover');
});

fileSelectArea.addEventListener('drop', (event) => {
  event.preventDefault();
  fileSelectArea.classList.remove('dragover');
  if (fileSelectArea.classList.contains('disabled')) return;
  if (event.dataTransfer.files.length > 0) {
    fileInput.files = event.dataTransfer.files;
    showSelectedFile(event.dataTransfer.files[0]);
  }
});

// Handle HTTP errors based on status code
async function handleHttpError(response, fileSizeMB) {
  const status = response.status;

  // Try to get error message from response body
  let serverMessage = '';
  try {
    const data = await response.json();
    serverMessage = data.error || data.detail || '';
  } catch (error) {
    // Response wasn't JSON
  }

  switch (status) {
    case 400:
      showError(
        resultDiv,
        'Invalid Request',
        serverMessage || 'The server could not process your request.',
        'Make sure you selected a valid audio file.'
      );
      break;

    case 413:
      showError(
        resultDiv,
        'File Too Large',
        `The file (${fileSizeMB.toFixed(1)} MB) exceeds the server limit of ${appSettings.maxFileSizeMB} MB.`,
        'Try compressing the audio or splitting it into smaller parts.'
      );
      break;

    case 500:
      showError(
        resultDiv,
        'Server Error',
        serverMessage || 'Something went wrong on the server.',
        'Please try again. If the problem persists, contact your administrator.'
      );
      break;

    case 502:
    case 503:
    case 504:
      showError(
        resultDiv,
        'Server Unavailable',
        'The server is temporarily unavailable.',
        'Please wait a moment and try again.'
      );
      break;

    default:
      showError(
        resultDiv,
        `Error (${status})`,
        serverMessage || 'An unexpected error occurred.',
        'Please try again or contact your administrator.'
      );
  }
}

// Handle network errors (e.g., connection issues, timeouts)
function handleNetworkError(error) {
  if (error instanceof JobFailedError) {
    showError(
      resultDiv,
      'Transcription Failed',
      error.message,
      'Please try again. If the problem persists, contact your administrator.'
    );
    return;
  }

  console.error('Network error:', error);

  // Check for specific error types
  if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
    showError(
      resultDiv,
      'Connection Failed',
      'Could not connect to the server.',
      'Check your network connection or verify the server is running.'
    );
  } else if (error.name === 'AbortError') {
    showError(
      resultDiv,
      'Upload Cancelled',
      'The upload was cancelled.',
      'Please try again.'
    );
  } else if (error.message.includes('timeout')) {
    showError(
      resultDiv,
      'Connection Timeout',
      'The server took too long to respond.',
      'The server might be busy. Please try again in a moment.'
    );
  } else {
    showError(
      resultDiv,
      'Unexpected Error',
      error.message || 'Something went wrong.',
      'Please try again. If the problem persists, contact your administrator.'
    );
  }
}

// Initialize the app by loading and applying the settings
await loadSettings();
applySettings();
