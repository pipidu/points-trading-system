// ============================================================
// R2 图片存储服务
// ============================================================
import { v4 as uuidv4 } from 'uuid';

/**
 * 上传文件到 R2
 * @returns 图片的公开访问 URL
 */
export async function uploadToR2(
  bucket: R2Bucket,
  file: File | ArrayBuffer,
  fileName: string,
  contentType: string,
  folder: string = 'uploads'
): Promise<string> {
  const ext = fileName.includes('.') ? fileName.split('.').pop() : 'jpg';
  const key = `${folder}/${uuidv4()}.${ext}`;

  const data = file instanceof File ? await file.arrayBuffer() : file;
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  });

  // 返回公开URL (需要在R2设置公开访问或通过Worker代理)
  return `/r2/${key}`;
}

/**
 * 通过 Worker 代理R2文件访问
 */
export async function serveR2File(
  bucket: R2Bucket,
  key: string
): Promise<Response | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

/**
 * 解析 multipart/form-data 中的文件
 */
export async function parseFormFile(request: Request): Promise<{ file: File | null; fields: Record<string, string> }> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return { file: null, fields: {} };
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key !== 'file' && typeof value === 'string') {
      fields[key] = value;
    }
  }
  return { file, fields };
}
