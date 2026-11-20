import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api.js';

export const MAX_PICTURES = 8;
const SENT_AS_IS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Claude takes up to 5 MB per picture and scales anything past ~1600 px down anyway.
const MAX_SIDE = 2000;
const MAX_BYTES = 3.5 * 1024 * 1024;

/** Big or unusual pictures are redrawn smaller as JPEG/PNG; small ones go as they are. */
async function prepare(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (SENT_AS_IS.has(file.type)) return file;
    throw new ApiError('bad_image');
  }
  const { width, height } = bitmap;
  const fits = Math.max(width, height) <= MAX_SIDE && file.size <= MAX_BYTES;
  if (fits && SENT_AS_IS.has(file.type)) {
    bitmap.close();
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // Screenshots stay sharp as PNG when that is small enough; photos become JPEG.
  const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (png && png.size <= MAX_BYTES) return png;
  const jpeg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  if (!jpeg) throw new ApiError('bad_image');
  return jpeg;
}

async function upload(agentId, blob) {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/uploads`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': blob.type },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? 'error', res.status);
  return data.id;
}

/**
 * Pictures attached to the message being typed: each is uploaded as soon as it is added, and the
 * message then names them by id. `url` is a local preview.
 */
export function usePictures(agentId) {
  const [list, setList] = useState([]);
  const live = useRef(list);
  useEffect(() => {
    live.current = list;
  }, [list]);

  // Previews are freed when the box goes away.
  useEffect(() => () => live.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const add = useCallback(
    (files) => {
      const room = MAX_PICTURES - live.current.length;
      const picked = [...files].filter((f) => f.type.startsWith('image/')).slice(0, Math.max(0, room));
      for (const file of picked) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const url = URL.createObjectURL(file);
        setList((l) => [...l, { key, url, name: file.name || 'image', id: null, error: null }]);
        prepare(file)
          .then((blob) => upload(agentId, blob))
          .then(
            (id) => setList((l) => l.map((p) => (p.key === key ? { ...p, id } : p))),
            (error) => setList((l) => l.map((p) => (p.key === key ? { ...p, error } : p))),
          );
      }
      return picked.length;
    },
    [agentId],
  );

  const remove = useCallback((key) => {
    setList((l) => {
      const gone = l.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
      return l.filter((p) => p.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    setList((l) => {
      l.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
  }, []);

  return {
    list,
    add,
    remove,
    clear,
    ids: list.filter((p) => p.id).map((p) => p.id),
    uploading: list.some((p) => !p.id && !p.error),
    full: list.length >= MAX_PICTURES,
  };
}
