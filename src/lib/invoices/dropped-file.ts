/**
 * The file to use for a drop: the first real file, in order. Anything else (extra files,
 * non-file items) is ignored. Returns null when the drop carries no file.
 */
export function firstDroppedFile(files: ArrayLike<File> | null | undefined): File | null {
  if (!files || files.length === 0) return null;
  const first = files[0];
  return first instanceof File ? first : null;
}
