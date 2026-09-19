const MB = 1024 * 1024;

export async function isAnimatedWebp(file) {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const text = new TextDecoder('ascii').decode(bytes);
  return text.slice(0,4)==='RIFF' && text.slice(8,12)==='WEBP' && text.slice(12,16)==='VP8X' && Boolean(bytes[20] & 2);
}

export async function prepareBackground(file) {
  if (!file || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片。');
  if (file.size > 30 * MB) throw new Error('原图超过 30MB，请先缩小后再选择。');
  const animated = file.type==='image/gif' || (file.type==='image/webp' && await isAnimatedWebp(file));
  if (animated) {
    if (file.size > 10*MB) throw new Error('动图需要保留原文件，请选择 10MB 以内的 GIF 或动态 WebP。');
    // Decode once to reject corrupt images before uploading, without replacing frames.
    const image = await createImageBitmap(file); image.close();
    return {blob:file,extension:file.type==='image/gif'?'gif':'webp',animated:true};
  }
  let bitmap;
  try { bitmap=await createImageBitmap(file); }
  catch {throw new Error('图片无法读取，请换一张完整的图片。');}
  try {
    if (bitmap.width*bitmap.height>60_000_000) throw new Error('图片像素过大，请先缩小到 6000 万像素以内。');
    const ratio=Math.min(1,2560/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*ratio)); canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    const context=canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片。');
    context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.82));
    if (!blob || blob.size>10*MB) throw new Error('图片压缩后仍然过大，请换一张较小的图片。');
    return {blob,extension:blob.type==='image/webp'?'webp':'png',animated:false};
  } finally {bitmap.close();}
}
