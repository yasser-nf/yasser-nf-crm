/**
 * Handing a generated file to the browser.
 *
 * The CSV is built on the server and arrives as a string, so there is no URL to
 * link to — the file exists only in memory until this runs. An object URL plus
 * a synthetic click is the only way to save one without inventing a route that
 * would need its own authorization.
 *
 * The URL is revoked immediately afterwards: it pins the blob in memory for the
 * lifetime of the document otherwise, and an operator exporting repeatedly
 * would accumulate every file they had ever downloaded.
 */
export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  /*
   * `charset=utf-8` alongside the byte order mark the CSV already carries.
   * Belt and braces: the BOM is what Excel actually reads, but a browser that
   * previews the file rather than saving it goes by the type.
   */
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;

  /*
   * Appended before clicking. Firefox ignores a click on an anchor that is not
   * in the document, which is the kind of difference that only shows up on
   * somebody else's machine.
   */
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

export function downloadCsv(csv: string, filename: string): void {
  downloadTextFile(csv, filename, "text/csv");
}
