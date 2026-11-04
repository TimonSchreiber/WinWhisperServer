// Helpers shared by all pages

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for use inside innerHTML, including attribute values (hence the quotes)
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

// Offer content as a file download
export function downloadFile(content, fileName, mimeType) {
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

// Error box with title, message, hint and an optional action link ({ label, href }); all texts are escaped
export function showError(container, title, message, hint, action) {
  const actionHtml = action
    ? `<a class="btn error-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
    : '';

  container.className = 'error';
  container.innerHTML = `
    <span class="material-icons" aria-hidden="true">error</span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(message)}</p>
    <p class="error-hint">
      <span class="material-icons" aria-hidden="true">lightbulb</span> ${escapeHtml(hint)}
    </p>
    ${actionHtml}
  `;
}

export function clearMessage(container) {
  container.className = '';
  container.innerHTML = '';
}
