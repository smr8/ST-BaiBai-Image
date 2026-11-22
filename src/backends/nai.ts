import { unzipSync } from 'fflate';
import { randomUuid } from '@/randomUuid';

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import type { ComfyImageResult } from '@/backends/comfyui';
import {
  parseRetryAfter,
  runNaiWithRetry,
  type NaiRetryInfo,
} from '@/backends/naiRateLimit';
import { parseSize, pickSize, type Orientation } from '@/backends/size';
import { clampVibeStrength, loadVibeData } from '@/backends/vibeStore';
import type { GenerationArtist, GenerationMeta, GenerationParams, GenerationVibe } from '@/generationMeta';
import type {
  NaiArtistPreset,
  NaiRunConfig,
  NaiVibe,
  NaiVibeData,
  NaiVibeEncodings,
} from '@/state/settings';

/**
 * NovelAI 生图后端(浏览器直连,协议与官方 image.novelai.net 一致)。
 * url 是**完整的生图端点**:填什么打什么,不再自动补 /ai 前缀 —— 官方站也照抄整段,
 * 第三方网关把生图挂在 /v1/nai/generate-image 这类路径下同样能接(见 naiEndpoint)。
 *
 * 参考 st-chatu8 的实现口径:
 * - 生图 POST {url},body {input, model, action:'generate', parameters}。
 * - 响应官方站是 zip(stream: 'msgpack'),解出第一张图;第三方网关可能直接回
 *   base64 JSON,两条口径都由 decodeNaiImage 收口。
 * - NAI3 的 vibe 直接发参考原图;NAI4/4.5 必须先经 encode-vibe 端点编码,
 *   生成时以 reference_image_multiple_cached(uuid + 编码数据) 形式叠加。
 * - .naiv4vibe 文件格式与官方互通(encodings 按模型 key 分组)。
 */

export class NaiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /**
     * 对方 Retry-After 换算出的毫秒数(没给则 null)。
     * 由 naiRateLimit 的重试器当退避下界用 —— 这是「该等多久」最权威的一手信息,
     * 扔掉它就只能凭指数退避瞎猜。
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'NaiError';
  }
}

/* ============ 常量表(与 st-chatu8 / NAI 官方前端同口径) ============ */

export const NAI_SAMPLERS: { value: string; label: string }[] = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES: { value: string; label: string }[] = [
  { value: 'karras', label: 'Karras(推荐)' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 各模型官方质量词，拼到正向提示词末尾;用户在面板改过则用其覆盖值。 */
const QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-full-medium': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/**
 * 各模型官方 Heavy 负面词，作为无需用户选择的通用默认;用户改过则用其覆盖值。
 * 5-full 在官方基线后额外串一条插件精选的通用负面层:只排画质/解剖/水印等**缺陷**,
 * 不含题材、风格、身材、画师偏好——那些会跟用户的正向词和画师串长期打架。
 * 5-full-medium 的负面词由官方固定为 Heavy 预设(见 naiFixedSettings),不串插件层。
 * 其余模型维持官方基线不动。
 */
const DEFAULT_UNDESIRED_CONTENT: Record<string, string> = {
  'nai-diffusion-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, watermark, signature, username, artist name, bad anatomy, bad hands, bad feet, extra digits, fewer digits, extra fingers, fused fingers, extra limbs, missing limbs, long neck, blurry, poorly drawn, unfinished, plastic skin, waxy skin, oversaturated, washed out',
  'nai-diffusion-5-full-medium':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-5-curated':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-3':
    'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
  'nai-diffusion-4-full':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview':
    'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-4-5-curated':
    'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full':
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
};

/**
 * 某模型的官方质量词 / 官方 Heavy 负面词。面板拿它做「未自定义」时的显示内容
 * 与「恢复默认」的目标,故必须导出:否则用户看不到实际生效的词(改动前的老问题)。
 */
export function naiDefaultQualityTags(model: string): string {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model: string): string {
  return DEFAULT_UNDESIRED_CONTENT[model] ?? '';
}

/** variety boost 的 magic 常数(st-chatu8 同口径):按像素量相对参考分辨率缩放。 */
const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export function isNai5(model: string): boolean {
  return model.includes('nai-diffusion-5');
}

/**
 * 官方锁死的采样参数(官方前端模型能力表里的 fixedSettings)。目前只有 V5 Full 的
 * Medium 档(官方叫「Medium Effort」):更快、更省 Anlas,代价是步数、采样器、负面词
 * 都由官方定死、不支持 CFG Rescale。官方前端对它直接隐藏这几项、发请求时强行改写,
 * 用户自填的负面词与角色负面词一律清空——这里照抄同一口径,不赌服务端收不收自定义值。
 * 其余模型 → null。
 */
export interface NaiFixedSettings {
  steps: number;
  sampler: string;
}

export function naiFixedSettings(model: string): NaiFixedSettings | null {
  return model.includes('nai-diffusion-5-full-medium') ? { steps: 14, sampler: 'k_euler_ancestral' } : null;
}

/**
 * V5 不支持 Vibe Transfer(官方未开放)。早先按「V5 也有 v5full 编码键」当成支持,
 * 结果 V5 用户照样被引导去上传编码、出图时把编码发过去。vibeModelKey 的 v5 键留着只为
 * 读写官方 .naiv4vibe 文件时不丢数据,不代表能用。
 */
export function naiSupportsVibes(model: string): boolean {
  return isNai3(model) || isNai4Family(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde',
]);

export function naiSamplers(model: string): { value: string; label: string }[] {
  return isNai5(model) ? NAI_SAMPLERS.filter(sampler => NAI_V5_SAMPLERS.has(sampler.value)) : NAI_SAMPLERS;
}

export function isNai45(model: string): boolean {
  return model.includes('nai-diffusion-4-5');
}

/**
 * 该模型是否走「Base Prompt + 原生 Character Prompts + 自然语言」这套协议。
 *
 * 边界是 4.5 而不是整个 v4 系:自然语言是 4.5 才引入的,原版 NAI4
 * (nai-diffusion-4-full / 4-curated-preview)只吃 tag。给它发英文 nl 句子
 * 属于未验证行为,故保持原样走单串 tag 规范。
 *
 * ⚠ 不要改回 isNai5:char_captions 所在的字段本来就叫 v4_prompt,这套结构是 V4 时代的
 * 协议,V5 只是继承。曾经按 isNai5 卡过,导致 4.5 明明支持却一条角色提示都发不出去。
 */
export function naiSupportsCharacterPrompts(model: string): boolean {
  return isNai45(model) || isNai5(model);
}

export function isNai4Family(model: string): boolean {
  return model.includes('nai-diffusion-4');
}

function isNai3(model: string): boolean {
  return model === 'nai-diffusion-3';
}

/** skip_cfg_above_sigma:开 variety boost 时按尺寸与模型算;关 → null。 */
export function skipCfgAboveSigma(width: number, height: number, model: string, varietyBoost: boolean): number | null {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============ 地址与基础工具 ============ */

/**
 * 解析 NAI 端点。接入点里填的 url **就是完整的生图端点**,原样使用:
 * `https://image.novelai.net/ai/generate-image`、`https://api.rinko.ai/v1/nai/generate-image`
 * 这类整段地址都由用户自己写全,不再自动拼 `/ai/generate-image`。
 *
 * 为什么不做「智能补全」:补全是猜。第三方网关把生图挂在 /v1/nai/ 下、镜像站挂在
 * /proxy/ 下,猜错时拼出来的地址看着能通、实际 404,用户对着一条自己没填过的 URL
 * 排查半天。填什么打什么之后,接入点地址就是请求地址,对不上了一眼能看出来。
 *
 * 代价是只填站点根会当场报错(见 endpointAsIs 的提示),而不是悄悄补成一条能发的地址。
 * 另外两个端点由生图端点推出,不是重新拼站点根:
 * - encode-vibe:与生图端点同目录(`.../ai/generate-image` → `.../ai/encode-vibe`);
 * - user/subscription:挂在站点根下(官方是 `/user/subscription`,不在 `/ai/` 下);
 *   第三方站多数没有这个接口,404 时 testNaiConnection 退化成「只验地址可达」。
 */
export function naiEndpoint(url: string, path: string): string {
  const base = url.trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('请先填写 NAI 接口地址');
  const seg = path.replace(/^\/+/, '');
  if (seg === 'generate-image') return endpointAsIs(base);
  if (seg === 'user/subscription') {
    const origin = endpointOrigin(base);
    return origin ? `${origin}/user/subscription` : `${base}/user/subscription`;
  }
  const swapped = base.replace(/\/generate-image$/, `/${seg}`);
  if (swapped !== base) return swapped;
  throw new NaiError(`接口地址需填到生图端点(…/generate-image),才能推出 ${seg};当前地址:${base}`);
}

/**
 * 生图端点原样返回,只拦下「只填了站点根」这一种写法:旧版靠 naiEndpoint 补 /ai,
 * 新版不补,那种地址发出去必然 404。静默兼容一次等于把「拼不拼」这个坑又埋回去,
 * 不如当场把该填的地址念给用户听。
 */
function endpointAsIs(base: string): string {
  if (!endpointOrigin(base)) {
    throw new NaiError(`NAI 接口地址无效:${base};应形如 https://image.novelai.net/ai/generate-image`);
  }
  if (!new URL(base).pathname.replace(/\/+$/, '')) {
    throw new NaiError(
      `NAI 接口地址需填完整生图端点,不能只填站点根;应形如 ${base}/ai/generate-image`,
    );
  }
  return base;
}

/** 站点根(协议 + 主机 + 端口);地址本身不合法 → null。 */
function endpointOrigin(base: string): string | null {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export interface NaiSize {
  width: number;
  height: number;
}

/** 解析「832×1216 / 832x1216」;宽高须为 64 的倍数、256–2048。 */
export function parseResolution(text: string): NaiSize {
  const size = parseSize(text);
  if (!size) throw new NaiError(`分辨率格式无效:${text || '(空)'};应如 832×1216`);
  const { width, height } = size;
  if (width % 64 !== 0 || height % 64 !== 0) {
    throw new NaiError(`分辨率 ${width}×${height} 不是 64 的倍数,NAI 要求宽高均为 64 的倍数`);
  }
  if (width < 256 || height < 256 || width > 2048 || height > 2048) {
    throw new NaiError(`分辨率 ${width}×${height} 超出 NAI 允许范围(256–2048)`);
  }
  return { width, height };
}

/** NAI 种子是 32 位无符号整数(与 ComfyUI 的 2^53 不同,不能复用 randomSeed)。 */
export function naiRandomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ============ payload 构造(纯函数,可测) ============ */

export interface NaiGenerateValues {
  /** 正向 tag(不含质量词)。 */
  prompt: string;
  nl?: string;
  characters?: ImageCharacterPrompt[];
  /** 种子;缺省随机。 */
  seed?: number;
  /** 画幅方向;缺省竖屏(与改动前的固定默认一致)。 */
  size?: Orientation;
}

/**
 * 内置画师串配方:只读,**不进 settings**,改它们 = 改这里的常量、发版即生效。
 *
 * 为什么不做成「首次启动播种进 settings」:写进 settings 那一刻默认值就冻在
 * 每个用户的设备上(还随 extension_settings 跨设备同步),以后再改只能靠
 * 「与旧种子逐字节比对」的指纹迁移,每改一次背一份旧种子。内置在代码里,
 * 默认值永远跟着版本走,已安装用户的 settings 一个字节不用动。
 *
 * 口径:
 * - id 用 bi_ 前缀(用户条目恒为 art_*),永不与用户库相撞;
 * - 只读:面板不给改名/删除,要自定义走「复制」建成用户条目再改;
 * - quality/negative 随条目一起生效;留空的字段按模型回落官方词(见 NaiArtistPreset);
 * - 新用户的默认方案选中第一条(见 settings.ts 的 naiDefaults);老用户的
 *   方案各自存着 artistId,不受这里影响;
 * - 要下线某条内置配方,至少留一个版本再删:正选中它的用户会走既有
 *   「id 悬空 → 清成不使用」逻辑,画风静默变掉,需慎重。
 */
export const BUILTIN_NAI_ARTISTS: readonly NaiArtistPreset[] = [
  {
    id: 'bi_default',
    name: '默认画师串',
    prompt:
      '0.8::nnmbpx::,0.8::artist:yalmyu::,0.1::smilesmile1312,::,  artist:sh_(shinh), 0.4::chen bin::,0.4::dayama::,healthyman,bacheally,',
    quality: '',
    negative: '',
  },
];

/** 该 id 是否是内置配方(面板据此只读化;用户条目 id 恒为 art_*,不可能撞上)。 */
export function isBuiltinNaiArtist(id: string): boolean {
  return BUILTIN_NAI_ARTISTS.some(a => a.id === id);
}

type JsonObject = Record<string, unknown>;

/** 当前生效的画师串快照（id / 名字 / 正文）。未选或正文全空白 → null。
 *  拼装（naiArtistPrompt）与随图记录（generateNaiImage 的 usage）都走这里，保证
 *  「真发出去的画师串」与「记下来的画师串」永远同源。
 *  引用已由 effectiveNai 解开(nai.artist),本文件不碰 settings —— settings.ts 已 import
 *  本模块的 naiDefaultUndesired,反向加值依赖会成运行时环(TDZ 隐患)。 */
export function naiArtistUsage(nai: NaiRunConfig): GenerationArtist | null {
  const preset = nai.artist;
  const prompt = preset?.prompt.trim() ?? '';
  // 全空白的 preset 必须归 null:'   ' 是 truthy,下游 filter(Boolean) 兜不住它
  if (!preset || !prompt) return null;
  return { id: preset.id, name: preset.name, prompt };
}

/** 当前生效的画师串:选中条目的正文;未选 / 指向已删条目 / 内容全空白 → 空串。 */
export function naiArtistPrompt(nai: NaiRunConfig): string {
  return naiArtistUsage(nai)?.prompt ?? '';
}

/**
 * 正面质量词:当前画师串的值 → 模型官方词。正/负面分别判断,
 * 空串或纯空白只让对应字段回落,不影响另一字段。方案旧字段不再参与。
 */
export function naiQualityTags(nai: NaiRunConfig): string {
  return nai.artist?.quality.trim() || naiDefaultQualityTags(nai.model);
}

/** 负面提示词:当前画师串的值 → 模型官方负面词(同 naiQualityTags)。
 *  官方锁死参数的模型(naiFixedSettings)不收自定义,恒为官方词。 */
export function naiUndesiredContent(nai: NaiRunConfig): string {
  if (naiFixedSettings(nai.model)) return naiDefaultUndesired(nai.model);
  return nai.artist?.negative.trim() || naiDefaultUndesired(nai.model);
}

/**
 * 正向完整 prompt:画师串在最前,画面 tag 居中,质量词在最后。
 * - 画师串 = 方案引用的条目(未选则无)。放最前是因为它决定整幅画的画风基调,
 *   NAI 对靠前 tag 的权重更高;
 * - 质量词 = 当前画师串里的值,留空则按模型取官方词(见 naiQualityTags)。
 *
 * ⚠ 本函数在 buildNaiParameters(v4_prompt 的来源)与 generateNaiImage 的顶层 input
 * 字段处各调一次,两处必须同源。拼装改动一律留在本函数内部——在某个调用点单独加料会让
 * NAI3(读 input)与 NAI4/4.5(读 v4_prompt)拿到不同的提示词,且只在 NAI3 上暴露。
 */
export function fullPositivePrompt(nai: NaiRunConfig, prompt: string, nl = ''): string {
  const artist = naiArtistPrompt(nai);
  const quality = naiQualityTags(nai);
  const tags = [artist, prompt.trim(), quality].filter(Boolean).join(', ');
  return naiSupportsCharacterPrompts(nai.model) && nl.trim() ? `${tags}. ${nl.trim()}` : tags;
}

function characterCaption(character: ImageCharacterPrompt): string {
  // Character Prompts identify one subject: library count tags (1girl/1boy) become girl/boy here.
  const tag = character.tag
    .split(',')
    .map(part => {
      const value = part.trim();
      if (/^\d+\s*girls?$/i.test(value)) return 'girl';
      if (/^\d+\s*boys?$/i.test(value)) return 'boy';
      return value;
    })
    .filter(Boolean)
    .join(', ');
  return character.nl.trim() ? `${tag}. ${character.nl.trim()}` : tag;
}

/**
 * 负面完整 prompt = 当前画师串的值 → 模型官方负面词(见 naiUndesiredContent)。
 */
export function fullNegativePrompt(nai: NaiRunConfig): string {
  return naiUndesiredContent(nai);
}

/**
 * 构造 parameters。v4 系模型带 v4_prompt/v4_negative_prompt 结构;NAI3 不带。
 * vibe 不在此叠加(见 applyVibes),保持「一次生成 = build + applyVibes」两步。
 */
export function buildNaiParameters(nai: NaiRunConfig, values: NaiGenerateValues): JsonObject {
  // 画幅按方向取用户配的那一格;没填回落竖屏默认
  const orientation = values.size ?? 'portrait';
  const { width, height } = parseResolution(pickSize(nai, orientation) || '832×1216');
  // 显式传入 > 面板固定种子 > 随机
  const seed = values.seed ?? (nai.seed > 0 ? nai.seed : naiRandomSeed());
  const prompt = fullPositivePrompt(nai, values.prompt, values.nl);
  const negative = fullNegativePrompt(nai);
  const skipCfg = skipCfgAboveSigma(width, height, nai.model, nai.varietyBoost);
  const fixed = naiFixedSettings(nai.model);
  const sampler =
    fixed?.sampler ?? (isNai5(nai.model) && !NAI_V5_SAMPLERS.has(nai.sampler) ? 'k_euler_ancestral' : nai.sampler);

  const params: JsonObject = {
    params_version: isNai5(nai.model) ? 4 : 3,
    width,
    height,
    scale: nai.scale,
    sampler,
    steps: fixed?.steps ?? nai.steps,
    n_samples: 1,
    // 提示词已由本地固定默认拼好；协议字段保持官方前端口径。
    ucPreset: 3,
    qualityToggle: true,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: fixed ? 0 : nai.cfgRescale,
    noise_schedule: nai.noiseSchedule,
    skip_cfg_above_sigma: skipCfg,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negative,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: nai.normalizeRefStrength,
    use_coords: false,
  };

  if (isNai3(nai.model)) {
    // NAI3:vibe 直接发参考原图;SME/SMEA 暂不开放(固定关)
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4/4.5/V5: v4 caption structure; Vibe uses a model-specific cached encoding.
    params.reference_image_multiple_cached = [];
    const charCaptions = naiSupportsCharacterPrompts(nai.model)
      ? (values.characters ?? []).map(character => ({
          char_caption: characterCaption(character),
          centers: [{ x: 0.5, y: 0.5 }],
        }))
      : [];
    params.characterPrompts = [];
    params.v4_prompt = {
      caption: { base_caption: prompt, char_captions: charCaptions },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: {
        base_caption: negative,
        char_captions: charCaptions.map(() => ({ char_caption: '', centers: [{ x: 0.5, y: 0.5 }] })),
      },
      legacy_uc: false,
    };
  }

  if (sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  return params;
}

/** vibe 模型 key:encodings 分组的键(与官方 .naiv4vibe 一致)。5-full-medium 与官方同口径归 v5full。 */
export function vibeModelKey(model: string): string {
  if (model.includes('nai-diffusion-5-curated')) return 'v5curated';
  if (model.includes('nai-diffusion-5-full')) return 'v5full';
  if (model.includes('4-5-curated')) return 'v4-5curated';
  if (model.includes('4-5-full')) return 'v4-5full';
  if (model.includes('4-curated')) return 'v4curated';
  if (model.includes('4-full')) return 'v4full';
  if (model.includes('diffusion-3')) return 'v3';
  return 'v4-5full';
}

/** 一次 applyVibes 的结果。 */
export interface VibeApplication {
  /** 实际叠加进 parameters 的 vibe（含配置强度与实际发送强度）。 */
  applied: GenerationVibe[];
  /** 因缺当前模型编码 / 缺原图 / 模型不支持而跳过的 vibe 名（供 toastr）。 */
  skipped: string[];
}

/**
 * 把方案勾选的 vibe(nai.vibes,effectiveNai 已按 vibeIds 滤好)叠加进 parameters。
 * - NAI3:参考原图进 reference_image_multiple(配信息提取度 1 + 强度);
 * - NAI4/4.5:编码数据进 reference_image_multiple_cached(随机 cache key),强度并进
 *   reference_strength_multiple;强度总和超过 1 且开启归一化时按比例压回 1。
 * 返回实际叠加的 vibe(供随图记录)与被跳过的 vibe 名(调用方据以提示)。
 */
export function applyVibes(
  params: JsonObject,
  nai: NaiRunConfig,
  dataById: ReadonlyMap<string, NaiVibeData>,
): VibeApplication {
  const active = nai.vibes;
  if (!active.length) return { applied: [], skipped: [] };
  if (!naiSupportsVibes(nai.model)) return { applied: [], skipped: active.map(vibe => vibe.name) };
  const applied: GenerationVibe[] = [];
  const skipped: string[] = [];
  const strengths = params.reference_strength_multiple as number[];

  if (isNai3(nai.model)) {
    const images = params.reference_image_multiple as string[];
    const infos = params.reference_information_extracted_multiple as number[];
    for (const vibe of active) {
      const data = dataById.get(vibe.id);
      if (!data?.image) {
        skipped.push(vibe.name);
        continue;
      }
      images.push(data.image);
      infos.push(1);
      strengths.push(vibe.strength);
      applied.push(vibeUsage(vibe, vibe.strength));
    }
    return { applied, skipped };
  }

  const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
  const modelKey = vibeModelKey(nai.model);
  const picked: NaiVibe[] = [];
  for (const vibe of active) {
    const enc = dataById.get(vibe.id)?.encodings[modelKey];
    if (!enc?.encoding) {
      skipped.push(vibe.name);
      continue;
    }
    cached.push({ cache_secret_key: randomUuid(), data: enc.encoding });
    picked.push(vibe);
  }
  // 归一化:总强度 > 1 时按比例压回 1(st-chatu8 同口径;4.5 开归一化时官方端也会自动处理)
  const total = picked.reduce((sum, vibe) => sum + vibe.strength, 0);
  const scale = nai.normalizeRefStrength && total > 1 ? 1 / total : 1;
  for (const vibe of picked) {
    const effective = vibe.strength * scale;
    strengths.push(effective);
    applied.push(vibeUsage(vibe, effective));
  }
  return { applied, skipped };
}

/** 造一条 vibe 使用记录：strength = 面板配置值，effectiveStrength = 实际发送值。 */
function vibeUsage(vibe: NaiVibe, effectiveStrength: number): GenerationVibe {
  return {
    id: vibe.id,
    name: vibe.name,
    group: vibe.group,
    strength: vibe.strength,
    effectiveStrength,
  };
}

/* ============ 网络请求 ============ */

async function naiHttpError(resp: Response, label: string): Promise<NaiError> {
  const text = (await resp.text().catch(() => '')).trim();
  let detail = text;
  try {
    const json = JSON.parse(text);
    if (typeof json?.message === 'string') detail = json.message;
  } catch {
    /* 非 JSON 错误体直接用原文 */
  }
  // Retry-After 一并带上:重试器拿它当退避下界(见 NaiError.retryAfterMs)
  const retryAfterMs = parseRetryAfter(resp.headers?.get('Retry-After'));
  switch (resp.status) {
    case 400:
      return new NaiError(`${label}:请求校验失败:${detail.slice(0, 300)}`, resp.status, retryAfterMs);
    case 401:
      return new NaiError(`${label}:API Key 错误或无效`, resp.status, retryAfterMs);
    case 402:
      return new NaiError(`${label}:需要有效订阅(402)`, resp.status, retryAfterMs);
    case 429:
      return new NaiError(
        `${label}:请求过于频繁(429),已自动退避重试;仍失败请调低「同时出图数」或稍后再试`,
        resp.status,
        retryAfterMs,
      );
    default:
      return new NaiError(`${label} (${resp.status}):${detail.slice(0, 300)}`, resp.status, retryAfterMs);
  }
}

/** 订阅接口的返回体:官方是 `{tier, active}` 或 `{subscription:{tier, active}}`。认不出 → null。 */
function parseNaiSubscription(text: string): { tier?: number; active?: boolean } | null {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const sub = typeof json.subscription === 'object' && json.subscription ? json.subscription : json;
  if (typeof sub.tier !== 'number' && typeof sub.active !== 'boolean') return null;
  return {
    tier: typeof sub.tier === 'number' ? sub.tier : undefined,
    active: typeof sub.active === 'boolean' ? sub.active : undefined,
  };
}

/** `/v1/models` 的模型 id 列表;不是这个形状(HTML 回落、错误体)就当空。 */
function parseModelIds(text: string): string[] {
  try {
    const json: any = JSON.parse(text);
    const list = Array.isArray(json?.data) ? json.data : [];
    return list.map((m: any) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 探测请求。浏览器的 CORS 失败只会抛一句 `Failed to fetch`,对用户毫无信息量 ——
 * 而那种情况改 key、改地址都救不回来,必须说清楚。
 */
async function naiProbe(url: string, key: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new NaiError(
      '连不上:请求没发出去 —— 网络不通,或被跨域(CORS)拦下。' +
        '若浏览器控制台里有 CORS 字样,说明对方没给 Access-Control-Allow-Origin,改 Key、改地址都没用:' +
        '本机跑 `node scripts/nai-cors-proxy.mjs` 加一层反代,接入点地址填 http://127.0.0.1:8787/v1/nai/generate-image',
    );
  }
}

/**
 * 测试连接。三层探测,越往后越宽松 —— 官方站与公益站/中转站能验的东西本来就不同:
 * 1. 官方订阅接口 `/user/subscription`:能同时验 key 与订阅等级;
 * 2. 第三方站没有这个接口(404,或把未知路径回落成前端 HTML、连 200 都照给)时,
 *    退到 OpenAI 兼容的 `/v1/models`:这把 key 拉得到模型列表,地址和 key 就都对;
 * 3. 都不认 → 只报地址可达,让用户以实际生图为准。
 *
 * 早先只做第 1 层,遇到「200 + 前端 HTML」的站会解析成空对象,报出「连接正常:Tier undefined」
 * —— 既不像成功也不像失败,是最糟的一种反馈。
 */
export async function testNaiConnection(
  nai: Pick<NaiRunConfig, 'url' | 'key'>,
  signal?: AbortSignal,
): Promise<{ message: string }> {
  const key = nai.key.trim();
  if (!key) throw new NaiError('请先填写 API Key');

  const sub = await naiProbe(naiEndpoint(nai.url, 'user/subscription'), key, signal);
  // 401 是明确的 key 问题;402 是订阅问题。403 不算:不少站对未知路径就回 403,继续往下探
  if (sub.status === 401 || sub.status === 402) throw await naiHttpError(sub, '连接 NAI 失败');
  if (sub.ok) {
    const info = parseNaiSubscription(await sub.text());
    if (info) {
      const tierName = ['Free', 'Tablet', 'Scroll', 'Opus'][Number(info.tier)] ?? `Tier ${info.tier}`;
      return { message: `连接正常:${tierName}${info.active === false ? '(订阅未激活)' : ''}` };
    }
    // 200 但不是订阅体:多半是前端 HTML 回落,接着探模型列表
  }

  const origin = endpointOrigin(nai.url.trim().replace(/\/+$/, ''));
  if (origin) {
    const models = await naiProbe(`${origin}/v1/models`, key, signal);
    if (models.status === 401) throw await naiHttpError(models, '连接 NAI 失败');
    if (models.ok) {
      const ids = parseModelIds(await models.text());
      if (ids.length) {
        const sample = ids.slice(0, 2).join('、') + (ids.length > 2 ? ' 等' : '');
        return { message: `连接正常:中转站可用,该 Key 能看到 ${ids.length} 个模型(${sample})` };
      }
    }
  }
  return { message: '地址可达,但该站没有订阅/模型接口;请以实际生图验证' };
}

/** 解 NAI 返回的 zip,取第一张图转 base64。 */
export function unzipNaiImage(buffer: ArrayBuffer): { base64: string; filename: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw new NaiError('响应不是有效的 zip 包(第三方站可能返回了其他格式)');
  }
  const name = Object.keys(files).find(n => /\.(png|jpe?g|webp)$/i.test(n)) ?? Object.keys(files)[0];
  if (!name) throw new NaiError('zip 包内没有图片文件');
  return { base64: uint8ToBase64(files[name]), filename: name };
}

/** 按魔数认格式:接口自报的 image_format 未必对,落盘扩展名跟真实字节走。 */
function imageFormatOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp';
  return 'png';
}

/** 从 JSON 里的一项取 base64:字符串本身,或 {b64_json|base64|data|image} 字段。 */
function base64OfImage(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['b64_json', 'base64', 'data', 'image']) {
      const hit = o[key];
      if (typeof hit === 'string' && hit) return hit.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    }
  }
  return null;
}

/** JSON 响应的两种口径:`{images:[b64]}`(new-api 系)与 `{data:[{b64_json}]}`(OpenAI 系)。 */
function imageFromJson(text: string): { base64: string; filename: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const root = (json ?? {}) as Record<string, unknown>;
  for (const list of [root.images, root.data]) {
    if (!Array.isArray(list) || !list.length) continue;
    const base64 = base64OfImage(list[0]);
    if (!base64) continue;
    return { base64, filename: `image_0.${imageFormatOf(base64ToUint8(base64))}` };
  }
  return null;
}

/**
 * 解生图响应,两条口径都认:
 * - 官方站:zip(stream: 'msgpack',内含 image_0.png);
 * - 部分第三方网关(如 new-api 系的 /v1/nai/generate-image):直接回 JSON,图片是 base64
 *   —— `{job, images: [b64], image_format: 'png'}` 或 OpenAI 式的 `{data: [{b64_json}]}`。
 *
 * 先看 zip 魔数再退 JSON,不靠 Content-Type:不少网关一律回 application/json、
 * 官方静态站又可能给 application/octet-stream,信头不如信字节。官方路径(解 zip)
 * 与改动前完全一致,第三方站只是多出一条分支。
 */
export function decodeNaiImage(buffer: ArrayBuffer): { base64: string; filename: string } {
  const bytes = new Uint8Array(buffer);
  // zip 本地文件头 "PK\x03\x04"
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return unzipNaiImage(buffer);
  const fromJson = imageFromJson(new TextDecoder().decode(bytes));
  if (fromJson) return fromJson;
  throw new NaiError('响应里既没有 zip 也没有 base64 图片(第三方站可能换了返回格式)');
}

/** generateNaiImage 的完整产出：图片 + 随图记录的元信息。 */
export interface NaiImageOutput {
  result: ComfyImageResult;
  /** 不在 tag 文本里的那部分配方（画师串 / vibe / 采样参数 / 模型无关字段）。 */
  usage: Pick<GenerationMeta, 'positive' | 'negative' | 'width' | 'height' | 'artist' | 'vibes' | 'params'>;
}

/**
 * 生图。返回图片与本次实际使用的画师串/vibe/采样参数。
 *
 * 429/5xx/网络级失败会自动退避重试(backends/naiRateLimit.ts);配置类错误
 * (key 错、订阅过期、参数非法)立刻抛出,不做无谓重试。onRetry 用于把退避过程
 * 报给卡片显示 —— 否则用户看着「生成中…」一动不动几十秒,只会以为卡死了再点一次。
 */
export async function generateNaiImage(
  nai: NaiRunConfig,
  values: NaiGenerateValues,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<NaiImageOutput> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  if (!values.prompt.trim()) throw new NaiError('正向提示词不能为空');

  // 画师串在发请求时解析一次，快照下来随图落盘：事后配方被删/改名也不丢。
  const artist = naiArtistUsage(nai);
  const params = buildNaiParameters(nai, values);
  const activeVibes = naiSupportsVibes(nai.model) ? nai.vibes : [];
  const loaded = new Map<string, NaiVibeData>();
  for (const vibe of activeVibes) {
    try {
      const data = await loadVibeData(vibe);
      loaded.set(
        vibe.id,
        isNai3(nai.model)
          ? data
          : {
              image: '',
              thumbnail: '',
              encodings: data.encodings,
            },
      );
    } catch (error) {
      console.warn(`[柏宝绘] 读取 vibe「${vibe.name}」失败:`, error);
    }
  }
  const { applied, skipped } = applyVibes(params, nai, loaded);
  if (skipped.length) {
    const reason = naiSupportsVibes(nai.model) ? '缺当前模型编码' : '当前模型不支持 Vibe Transfer';
    console.warn(`[柏宝绘] 以下 vibe 因${reason}被跳过:`, skipped);
    toastr.warning(`vibe「${skipped.join('、')}」${reason},已跳过`, '柏宝绘');
  }

  const bodyFor = (parameters: JsonObject) => ({
    input: fullPositivePrompt(nai, values.prompt, values.nl),
    model: nai.model,
    action: 'generate',
    parameters,
    use_new_shared_trial: true,
  });
  const post = (payload: unknown) =>
    fetch(naiEndpoint(nai.url, 'generate-image'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${nai.key.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  // 只把「发请求 + 解包」包进重试:上面拼参数、读 vibe 数据的活是一次性的,
  // 重跑它们既白费功夫,也会把 vibe 缺编码的 toastr 警告重复弹出来。
  const result = await runNaiWithRetry(
    async () => {
      let resp = await post(bodyFor(params));
      // stream: 'msgpack' 是官方取 zip 的要求,但有些中转站(实测 new-api 系)不认它:
      // 收到就回一个光秃秃的 502,去掉则正常返回 base64 JSON。502 无法区分「参数被拒」
      // 与「上游真挂了」,故只在 5xx 且带了 stream 时摘掉重试一次 —— 官方站不会走到这里
      // (它认 stream,不会 5xx),第三方站则通常一次就过。
      if (resp.status >= 500 && 'stream' in params) {
        console.warn(`[柏宝绘] 生图返回 ${resp.status},疑似不支持 stream=msgpack;摘掉该字段重试一次`);
        const withoutStream = { ...params };
        delete withoutStream.stream;
        resp = await post(bodyFor(withoutStream));
      }
      if (!resp.ok) throw await naiHttpError(resp, 'NAI 生图失败');

      // zip(官方)/ JSON(第三方网关)都在这里收口,见 decodeNaiImage
      const { base64, filename } = decodeNaiImage(await resp.arrayBuffer());
      const format = filename.split('.').pop()?.toLowerCase() || 'png';
      return {
        url: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${base64}`,
        filename: `nai-${Date.now()}.${format}`,
        format,
        revoke() {},
      };
    },
    { signal, onRetry: opts.onRetry, gate: nai.endpointId },
  );

  return {
    result,
    usage: {
      // positive 即顶层 input / v4_prompt 里那份全文（含画师串与质量词）
      positive: fullPositivePrompt(nai, values.prompt, values.nl),
      negative: fullNegativePrompt(nai),
      width: params.width as number,
      height: params.height as number,
      artist,
      vibes: applied,
      params: naiParamsSnapshot(params, nai),
    },
  };
}

/** 采样参数快照：只收标量，不含提示词与 vibe 二进制。 */
function naiParamsSnapshot(params: JsonObject, nai: NaiRunConfig): GenerationParams {
  return {
    sampler: params.sampler as string,
    steps: params.steps as number,
    cfg: params.scale as number,
    cfgRescale: params.cfg_rescale as number,
    noiseSchedule: params.noise_schedule as string,
    quality: naiQualityTags(nai),
    varietyBoost: nai.varietyBoost,
    normalizeRefStrength: nai.normalizeRefStrength,
  };
}

/* ============ vibe 编码与 .naiv4vibe 互通 ============ */

/** 官方 .naiv4vibe 里 encoding 的固定内层 key(与 st-chatu8 同)。 */
export const VIBE_ENCODING_KEY = 'b36a8472fe418d9f80d6bb1c54e3a6e62c62936aa7bf31dae2bcf7e929f6430f';

/**
 * 调 /ai/encode-vibe 把参考图编码成 vibe 数据(base64)。
 * NAI4/4.5 的 vibe 必须经此编码;NAI3 不需要(直接发原图)。
 *
 * 与生图同样带退避重试:这也是一次真实的 NAI 请求,吃 429 时不该只是弹个红条了事。
 * (并发槽由调用方取,见 pages/backend/panels/NaiPanel.vue —— 与卡片同一条纪律,同一个接入点闸门。)
 */
export async function encodeVibeImage(
  nai: Pick<NaiRunConfig, 'endpointId' | 'url' | 'key'>,
  imageBase64: string,
  model: string,
  infoExtracted = 1,
  signal?: AbortSignal,
  opts: { onRetry?: (info: NaiRetryInfo) => void } = {},
): Promise<string> {
  if (!nai.key.trim()) throw new NaiError('请先填写 NAI API Key');
  return runNaiWithRetry(
    async () => {
      const resp = await fetch(naiEndpoint(nai.url, 'encode-vibe'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${nai.key.trim()}`,
        },
        body: JSON.stringify({ image: imageBase64, information_extracted: infoExtracted, model }),
        signal,
      });
      if (!resp.ok) throw await naiHttpError(resp, 'vibe 编码失败');
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.length < 100) {
        throw new NaiError(`vibe 编码数据异常(仅 ${bytes.length} 字节),接口可能返回了错误响应`);
      }
      return uint8ToBase64(bytes);
    },
    { signal, onRetry: opts.onRetry, gate: nai.endpointId },
  );
}

export interface ImportedVibe {
  name: string;
  image: string;
  thumbnail: string;
  encodings: NaiVibeEncodings;
  strength: number;
}

/** 解析 .naiv4vibe 文件文本(JSON)为 vibe 条目(不含 id,由调用方补)。 */
export function parseNaiv4vibe(text: string): ImportedVibe {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NaiError('不是有效的 .naiv4vibe 文件(JSON 解析失败)');
  }
  if (json?.identifier !== 'novelai-vibe-transfer') {
    throw new NaiError('不是 NovelAI vibe 文件(缺少 novelai-vibe-transfer 标识)');
  }
  const encodings: NaiVibeEncodings = {};
  for (const [modelKey, group] of Object.entries(json.encodings ?? {})) {
    const first = Object.values(group as Record<string, any>)[0];
    if (typeof first?.encoding === 'string' && first.encoding) {
      encodings[modelKey] = {
        encoding: first.encoding,
        infoExtracted:
          typeof first.params?.information_extracted === 'number'
            ? first.params.information_extracted
            : 1,
      };
    }
  }
  if (!Object.keys(encodings).length) throw new NaiError('vibe 文件里没有可用的编码数据');
  return {
    name: typeof json.name === 'string' && json.name ? json.name : '导入的 Vibe',
    image: typeof json.image === 'string' ? json.image : '',
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : '',
    encodings,
    strength: clampVibeStrength(json.importInfo?.strength),
  };
}

/** 导出为官方兼容的 .naiv4vibe JSON(全部已编码模型一并带上)。 */
export async function buildNaiv4vibe(vibe: NaiVibe, data: NaiVibeData): Promise<string> {
  const encodings: Record<string, unknown> = {};
  for (const [modelKey, enc] of Object.entries(data.encodings)) {
    encodings[modelKey] = {
      [VIBE_ENCODING_KEY]: {
        encoding: enc.encoding,
        params: { information_extracted: enc.infoExtracted },
      },
    };
  }
  const id = data.image ? await sha256Hex(data.image) : randomUuid();
  return JSON.stringify({
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: data.image,
    id,
    encodings,
    name: vibe.name,
    thumbnail: data.thumbnail,
    createdAt: Date.now(),
    importInfo: {
      model: Object.keys(data.encodings)[0] ?? '',
      information_extracted: 1,
      strength: vibe.strength,
    },
  });
}
