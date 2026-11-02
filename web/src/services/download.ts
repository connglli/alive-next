export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // The browser starts consuming the object URL asynchronously after the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
