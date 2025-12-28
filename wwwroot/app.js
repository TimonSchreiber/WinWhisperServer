const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');
const uploadBtn = document.getElementById('uploadBtn');
const selectBtn = document.getElementById('selectBtn');
const fileNameDiv = document.getElementById('fileName');
const resultDiv = document.getElementById('result');

function showSelectedFile(file) {
  fileNameDiv.innerHTML = `Selected file: <strong>${file.name}</strong> (${formatBytes(file.size)})`;
  uploadBtn.disabled = false;
  resultDiv.className = '';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function downloadFile(content, fileName) {
  const blob = new Blob([content], { type: 'text/plain' });
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

  uploadBtn.disabled = true;
  uploadBtn.classList.add('loading');


  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    const contentType = response.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      // fallback: server returned HTML or plain text - show it as an error
      const text = await response.text();
      data = { error: 'Non.JSON response from server', detail: text, transcription: text };
    }

    if (!response.ok) {
      throw new Error(data.detail || data.error || 'Upload failed');
    }

    const fileName = file.name.substring(0, file.name.lastIndexOf('.'));

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
        <pre>${escapeHtml(data.transcription)}</pre>
      </div>
    `;
    resultDiv.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('srtDownloadBtn').addEventListener('click', () => {
      downloadFile(data.transcription, `${fileName}.srt`);
    });

    document.getElementById('txtDownloadBtn').addEventListener('click', () => {
      downloadFile(data.plainText, `${fileName}.txt`);
    });

  } catch (error) {
    resultDiv.className = 'error';
    resultDiv.textContent = `<span class="material-icons">error</span> Error: ${error.message}`;
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.classList.remove('loading');
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// File selection
selectBtn.addEventListener('click',  () => fileInput.click());
uploadBtn.addEventListener('click', uploadFile);

fileInput.addEventListener('change', (event) => {
  if (event.target.files.length > 0) {
    showSelectedFile(event.target.files[0]);
  }
});

// Drag and drop
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  if (event.dataTransfer.files.length > 0) {
    fileInput.files = event.dataTransfer.files;
    showSelectedFile(event.dataTransfer.files[0]);
  }
});
