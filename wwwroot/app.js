// Global settings
let appSettings = {
  maxFileSizeMB: 30,
  outputFormats: ['json', 'srt'],
};

// Load settings from backend
(async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    if (response.ok) {
      appSettings = await response.json();
    }
  } catch (error) {
    console.warn('Could not load settings, using default values:', error);
  }
})();

const fileInput = document.getElementById('fileInput');
const fileSelectArea = document.getElementById('fileSelectArea');
const transcribeBtn = document.getElementById('transcribeBtn');
const browseBtn = document.getElementById('browseBtn');
const fileNameDiv = document.getElementById('fileName');
const resultDiv = document.getElementById('result');

function showSelectedFile(file) {
  const sizeText = formatBytes(file.size);
  const fileSizeMB = file.size / (1024 * 1024);
  const limitMB = appSettings.maxFileSizeMB;

  // Warn if file is within 10% of limit
  const warningThreshold = limitMB * 0.9;
  const showWarning = fileSizeMB > warningThreshold;

  let warningHtml = showWarning
    ? `
      <div class="file-warning">
        <span class="material-icons">warning</span>
        File might exceed upload limit of ${limitMB} MB
      </div>
    `
    : '';

  fileNameDiv.innerHTML = `
    Selected file: <strong>${file.name}</strong> (${sizeText})
    ${warningHtml}
  `;

  transcribeBtn.disabled = false;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function uploadFile() {
  const file = fileInput.files[0];
  if (!file) return;

  const fileSizeMB = file.size / (1024 * 1024);

  transcribeBtn.disabled = true;
  browseBtn.disabled = true;
  fileInput.disabled = true;
  fileSelectArea.classList.add('disabled');
  transcribeBtn.classList.add('loading');

  resultDiv.className = 'processing';
  resultDiv.innerHTML = `
    <span class="material-icons">hourglass_empty</span>
    <strong>Uploading...</strong>
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div id="progressText">0%</div>
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
      <span class="material-icons">hourglass_empty</span>
      <strong>Processing...</strong>
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div id="progressText">Queued...</div>
    `;

    resultDiv.scrollIntoView({ behavior: 'smooth' });

    // Poll for status
    const result = await pollForCompletion(jobId);
    showResult(result, file.name);
  } catch (error) {
    if (error instanceof TypeError && fileSizeMB > appSettings.maxFileSizeMB) {
      showError(
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
  }
}

async function pollForCompletion(jobId) {
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');

  while (true) {
    const response = await fetch(`/api/status/${jobId}`);
    const data = await response.json();

    switch (data.status) {
      case 'queued':
        progressText.textContent = `Queued... (${data.queuePosition} before you)`;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every second
        break;
      case 'processing':
        progressFill.style.width = `${data.progress ?? 0}%`;
        progressText.textContent = data.progress == null
          ? 'Detecting Language...'
          : `Processing: ${data.progress}%`;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every second
        break;
      case 'complete':
        return data;
      case 'error':
        throw new Error(data.error ||'Processing failed');
      default:
        throw new Error(`Unknowd status: ${data.status}`);
    }
  }
}

function showResult(data, originalFileName) {
  const fileName = originalFileName.substring(0, originalFileName.lastIndexOf('.'));
  const outputs = data.outputs || {};
  const formats = Object.keys(outputs);

  if (formats.length === 0) {
      resultDiv.className = 'error';
      resultDiv.innerHTML = `<span class="material-icons">error</span> No output files received`;
      return;
  }

  const durationText = data.duration
    ? `<p>Completed in: <strong>${data.duration}</strong></p>`
    : '';

  // Create download buttons for each format
  const downloadButtons = formats.map(format => `
    <button class="btn download-btn" data-format="${format}" data-filename="${fileName}">
        <span class="material-icons">download</span> ${fileName}.${format}
    </button>
  `).join('');

  // Preview: use order from settings, fallback to first available
  const previewFormat = appSettings.outputFormats.find((f) => formats.includes(f)) || formats[0];
  const previewContent = data.outputs[previewFormat];

  resultDiv.className = 'success';
  resultDiv.innerHTML = `
    <strong><span class="material-icons">check_circle</span> Transcription Complete!</strong>
    ${durationText}
    <div class="transcription-actions">
      ${downloadButtons}
    </div>
    <div class="transcription-preview">
      <strong>Preview (${previewFormat}):</strong>
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

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// File selection
browseBtn.addEventListener('click',  () => fileInput.click());
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

// Error handler functions
function showError(title, message, hint) {
  resultDiv.className = 'error';
  resultDiv.innerHTML = `
    <span class="material-icons">error</span>
    <strong>${title}</strong>
    <p>${message}</p>
    <p class="error-hint"><span class="material-icons">lightbulb</span> ${hint}</p>
  `;
}

async function handleHttpError(response, fileSizeMB) {
  const status = response.status;

  // Try to get error message form respinse body
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
        'Invalid Request',
        serverMessage || 'The server could not process your request.',
        'Make sure you selected a valid audio file.'
      );
      break;

    case 413:
      showError(
        'File Too Large',
        `The file (${fileSizeMB.toFixed(1)} MB) exceeds the server limit of ${appSettings.maxFileSizeMB} MB.`,
        'Try compressing the audio or splitting it into smaller parts.'
      );
      break;

    case 500:
      showError(
        'Server Error',
        serverMessage || 'Something went wrong on the server.',
        'Please try again. If the problem persists, contact your administrator.'
      );
      break;

    case 502:
    case 503:
    case 504:
      showError(
        'Server Unavailable',
        'The server is temporarily unavailable.',
        'Please wait a moment and try again.'
      );
      break;

    default:
      showError(
        `Error (${status})`,
        serverMessage || 'An unexpected error occurred.',
        'Please try again or contact your administrator.'
      );
  }
}

function handleNetworkError(error) {
  console.error('Network error:', error);

  // Check for specifix error types
  if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
    showError(
      'Connection Failed',
      'Could not connect to the server.',
      'Check your network connection or verify the server is running.'
    );
  } else if (error.name === 'AbortError') {
    showError(
      'Upload Cancelled',
      'The upload was cancelled.',
      'Please try again.'
    );
  } else if (error.message.includes('timeout')) {
    showError(
      'Connection Timeout',
      'The server took too long to respond.',
      'The server might be busy. Please try again in a moment.'
    );
  } else if (error.message.includes('process')) {
    showError(
      'Processing Failed',
      'The server failed to process the file.',
      'Please try again. If the problem persists, contact your administrator.'
    );
  } else {
    showError(
      'Unexpected Error',
      error.message || 'Something went wrong.',
      'Please try again. If the problem persists, contact your administrator.'
    );
  }
}
