const fileInput = document.getElementById('fileInput');
const fileSelectArea = document.getElementById('fileSelectArea');
const transcribeBtn = document.getElementById('transcribeBtn');
const browseBtn = document.getElementById('browseBtn');
const fileNameDiv = document.getElementById('fileName');
const resultDiv = document.getElementById('result');

function showSelectedFile(file) {
  fileNameDiv.innerHTML = `Selected file: <strong>${file.name}</strong> (${formatBytes(file.size)})`;
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

  transcribeBtn.disabled = true;
  browseBtn.disabled = true;
  fileInput.disabled = true;
  fileSelectArea.classList.add('disabled');
  transcribeBtn.classList.add('loading');

  resultDiv.className = 'processing';
  resultDiv.style.display = 'block';
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

    const uploadData = await uploadResponse.json();
    if (!uploadResponse.ok) {
      throw new Error(uploadData.error || 'Upload failed');
    }

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
    resultDiv.className = 'error';
    resultDiv.innerHTML = `<span class="material-icons">error</span> Error: ${error.message}`;
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

    // Create download button
    resultDiv.className = 'success';
    resultDiv.innerHTML = `
      <strong><span class="material-icons">check_circle</span> Transcription Complete!</strong>
      <div class="transcription-actions">
        <button class="btn download-btn" id="srtDownloadBtn">
          <span class="material-icons">download</span> ${fileName}.srt
        </button>
        <button class="btn download-btn" id="txtDownloadBtn">
          <span class="material-icons">download</span> ${fileName}.txt
        </button>
      </div>
      <div class="transcription-preview">
        <strong>Preview:</strong>
        <pre>${escapeHtml(data.transcription || data.plaintext)}</pre>
      </div>
    `;

    document.getElementById('srtDownloadBtn').addEventListener('click', () => {
      downloadFile(data.transcription, `${fileName}.srt`, 'application/x-subrip');
    });

    document.getElementById('txtDownloadBtn').addEventListener('click', () => {
      downloadFile(data.plainText, `${fileName}.txt`, 'text/plain');
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
