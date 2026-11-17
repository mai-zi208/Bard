import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegPathModule from 'ffmpeg-static';

// 运行时 default 就是 ffmpeg 可执行路径字符串；包自带的 d.ts 与 NodeNext 的 CJS 互操作建模不一致，此处按实际形态修正
const ffmpegPath = ffmpegPathModule as unknown as string | null;

/** ffmpeg 转码：44.1kHz 单声道 64kbps MP3，避免 24kHz 源被再次砍高频 */
export async function encodeMp3(wav: Buffer): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg-static 未提供可执行路径');

  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '44100',
      '-b:a',
      '64k',
      '-f',
      'mp3',
      'pipe:1'
    ]);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error('MP3 转码失败：' + Buffer.concat(errors).toString().slice(0, 200)));
    });
    child.stdin.end(wav);
  });
}

/** 无头 PCM 包成 WAV：流式接口只给裸 PCM，转 MP3 前需要补 RIFF 头 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
