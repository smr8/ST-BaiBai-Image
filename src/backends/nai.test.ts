import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyVibes,
  buildNaiParameters,
  BUILTIN_NAI_ARTISTS,
  decodeNaiImage,
  fullNegativePrompt,
  fullPositivePrompt,
  generateNaiImage,
  isBuiltinNaiArtist,
  naiArtistPrompt,
  naiDefaultQualityTags,
  naiDefaultUndesired,
  naiEndpoint,
  naiFixedSettings,
  naiOrigin,
  naiRandomSeed,
  naiSupportsCharacterPrompts,
  naiSupportsVibes,
  parseNaiv4vibe,
  parseResolution,
  skipCfgAboveSigma,
  testNaiConnection,
  unzipNaiImage,
  vibeModelKey,
  NaiError,
} from '@/backends/nai';
import type { NaiArtistPreset, NaiModel, NaiRunConfig, NaiVibe, NaiVibeData } from '@/state/settings';
import { strToU8, zipSync } from 'fflate';

/** 一次请求的已解析配置(effectiveNai 的产物);后端只认它,不碰 settings。 */
function nai(overrides: Partial<NaiRunConfig> = {}): NaiRunConfig {
  return {
    endpointId: 'nep_official',
    url: 'https://image.novelai.net/ai/generate-image',
    key: 'nai-test',
    model: 'nai-diffusion-4-5-full',
    artist: null,
    qualityTags: '',
    undesiredContent: '',
    sampler: 'k_euler',
    steps: 28,
    scale: 5,
    cfgRescale: 0,
    noiseSchedule: 'karras',
    seed: 0,
    varietyBoost: true,
    normalizeRefStrength: true,
    vibes: [],
    portraitSize: '832×1216',
    landscapeSize: '1216×832',
    ...overrides,
  };
}

function vibe(overrides: Partial<NaiVibe> = {}): NaiVibe {
  return {
    id: 'v1',
    name: '测试Vibe',
    dataPath: '/user/files/v1.json',
    thumbnailPath: '/user/files/v1.jpg',
    modelKeys: ['v4-5full'],
    hasImage: true,
    fingerprint: 'v4-5full:ZW5jb2Rpbmc=',
    strength: 0.6,
    group: '',
    ...overrides,
  };
}

function vibeData(overrides: Partial<NaiVibeData> = {}): NaiVibeData {
  return {
    image: 'aW1hZ2U=',
    thumbnail: '',
    encodings: { 'v4-5full': { encoding: 'ZW5jb2Rpbmc=', infoExtracted: 1 } },
    ...overrides,
  };
}

describe('naiEndpoint', () => {
  it('生图端点原样使用(不再补 /ai 前缀)', () => {
    expect(naiEndpoint('https://image.novelai.net/ai/generate-image', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
    // 第三方网关把生图挂在任意路径下:填什么打什么
    expect(naiEndpoint('https://api.rinko.ai/v1/nai/generate-image', 'generate-image')).toBe(
      'https://api.rinko.ai/v1/nai/generate-image',
    );
    // 尾斜杠只做规整,不改变路径
    expect(naiEndpoint('https://image.novelai.net/ai/generate-image/', 'generate-image')).toBe(
      'https://image.novelai.net/ai/generate-image',
    );
  });

  it('只填站点根 → 报错并给出该填的地址', () => {
    // 只剩 origin 时无法猜测生图挂在哪条路径下:旧版靠补 /ai 蒙对,新版直接报错指路
    expect(() => naiEndpoint('https://image.novelai.net', 'generate-image')).toThrow(/完整生图端点/);
    expect(() => naiEndpoint('https://api.rinko.ai/', 'generate-image')).toThrow(/完整生图端点/);
    // 带路径但不叫 generate-image 的地址照原样发:是不是端点由用户决定,不拦
    expect(naiEndpoint('https://api.rinko.ai/v1/nai/gen', 'generate-image')).toBe(
      'https://api.rinko.ai/v1/nai/gen',
    );
  });

  it('encode-vibe 与生图端点同目录', () => {
    expect(naiEndpoint('https://image.novelai.net/ai/generate-image', 'encode-vibe')).toBe(
      'https://image.novelai.net/ai/encode-vibe',
    );
    expect(naiEndpoint('https://api.rinko.ai/v1/nai/generate-image', 'encode-vibe')).toBe(
      'https://api.rinko.ai/v1/nai/encode-vibe',
    );
  });

  it('订阅接口挂在站点根下,不在生图端点目录下', () => {
    expect(naiEndpoint('https://image.novelai.net/ai/generate-image', 'user/subscription')).toBe(
      'https://image.novelai.net/user/subscription',
    );
    expect(naiEndpoint('https://gw.example.com/proxy/ai/generate-image', 'user/subscription')).toBe(
      'https://gw.example.com/user/subscription',
    );
  });

  it('空地址与非法地址报错', () => {
    expect(() => naiEndpoint('  ', 'generate-image')).toThrow(NaiError);
    expect(() => naiEndpoint('image.novelai.net/ai/generate-image', 'generate-image')).toThrow(NaiError);
  });
});

describe('parseResolution', () => {
  it('支持 × / x / * 分隔', () => {
    expect(parseResolution('832×1216')).toEqual({ width: 832, height: 1216 });
    expect(parseResolution('1024x1024')).toEqual({ width: 1024, height: 1024 });
  });

  it('拒绝非 64 倍数与非法格式', () => {
    expect(() => parseResolution('830×1216')).toThrow(/64/);
    expect(() => parseResolution('')).toThrow(NaiError);
    expect(() => parseResolution('4096×4096')).toThrow(/范围/);
  });
});

describe('提示词拼装', () => {
  it('使用模型官方质量词并拼到提示词末尾', () => {
    const full = fullPositivePrompt(nai(), '1girl, sitting');
    expect(full).toBe('1girl, sitting, location, very aesthetic, masterpiece, no text');
  });

  it('按模型切换官方质量词', () => {
    expect(fullPositivePrompt(nai({ model: 'nai-diffusion-4-5-curated' }), '1girl')).toBe(
      '1girl, location, masterpiece, no text, -0.8::feet::, rating:general',
    );
  });

  it('负面 = 模型官方默认词', () => {
    const neg = fullNegativePrompt(nai());
    expect(neg).toContain('worst quality');
  });

  it('方案旧字段不参与出图:未选画师串时使用模型官方词', () => {
    expect(fullPositivePrompt(nai({ qualityTags: 'legacy plan quality' }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ undesiredContent: 'legacy plan negative' }))).toBe(
      naiDefaultUndesired('nai-diffusion-4-5-full'),
    );
  });

  it('画师串覆盖值留空 = 跟随模型官方词(切模型内容跟着换)', () => {
    // 这是「空串 = 跟随官方」这条存储口径的核心契约
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: '', negative: '' };
    const asFull = fullPositivePrompt(nai({ artist, model: 'nai-diffusion-3' }), '1girl');
    expect(asFull).toBe('1girl, best quality, amazing quality, very aesthetic, absurdres');
    expect(fullNegativePrompt(nai({ artist, model: 'nai-diffusion-3' }))).toContain('{bad}');
  });

  it('画师串纯空白覆盖值等同留空', () => {
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: '   ', negative: '  \n ' };
    expect(fullPositivePrompt(nai({ artist }), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(nai({ artist }))).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });

  it('未知模型无官方词时回落空串,不抛', () => {
    expect(naiDefaultQualityTags('nai-diffusion-9')).toBe('');
    expect(naiDefaultUndesired('nai-diffusion-9')).toBe('');
    const odd = nai({ model: 'nai-diffusion-9' as NaiModel });
    expect(fullPositivePrompt(odd, '1girl')).toBe('1girl');
    expect(fullNegativePrompt(odd)).toBe('');
  });
});

describe('画师串拼装', () => {
  const preset = (prompt: string, id = 'art_a', extra: Partial<NaiArtistPreset> = {}): NaiArtistPreset => ({
    id,
    name: 'A',
    prompt,
    quality: '',
    negative: '',
    ...extra,
  });

  it('未选画师串 → 输出与本功能上线前逐字节一致(存量用户零变化)', () => {
    expect(fullPositivePrompt(nai(), '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('画师串拼在最前:画师串 → 画面 tag → 质量词', () => {
    const s = nai({ artist: preset('artist:wlop, artist:krenz') });
    expect(fullPositivePrompt(s, '1girl, sitting')).toBe(
      'artist:wlop, artist:krenz, 1girl, sitting, location, very aesthetic, masterpiece, no text',
    );
  });

  it('选中条目内容全空白 → 等同不使用,不留前导逗号', () => {
    // '   ' 是 truthy,filter(Boolean) 兜不住,故 naiArtistPrompt 内部必须 trim
    const s = nai({ artist: preset('   ') });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      '1girl, location, very aesthetic, masterpiece, no text',
    );
  });

  it('与画师串质量词共存,顺序仍是 画师串 → tag → 质量词', () => {
    const s = nai({ artist: preset('artist:a', 'art_a', { quality: 'best quality' }) });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, best quality');
  });

  it('naiArtistPrompt 两态:未选 / 选中(选中时首尾空白被去掉)', () => {
    expect(naiArtistPrompt(nai())).toBe('');
    expect(naiArtistPrompt(nai({ artist: preset(' artist:a ') }))).toBe('artist:a');
  });
});

describe('画师串正/负面词', () => {
  const preset: NaiArtistPreset = {
    id: 'art_a',
    name: 'A',
    prompt: 'artist:a',
    quality: 'artist quality',
    negative: 'artist negative',
  };

  it('画师串有值就只使用画师串,方案旧值与官方词都不叠加', () => {
    const s = nai({ artist: preset, qualityTags: 'plan quality', undesiredContent: 'plan negative' });
    expect(fullPositivePrompt(s, '1girl')).toBe('artist:a, 1girl, artist quality');
    expect(fullNegativePrompt(s)).toBe('artist negative');
  });

  it('正/负面分别回落:一边留空只让该边使用官方词', () => {
    const qualityOnly = nai({ artist: { ...preset, negative: '' } });
    expect(fullPositivePrompt(qualityOnly, '1girl')).toBe('artist:a, 1girl, artist quality');
    expect(fullNegativePrompt(qualityOnly)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));

    const negativeOnly = nai({ artist: { ...preset, quality: '', negative: 'artist negative' } });
    expect(fullPositivePrompt(negativeOnly, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(negativeOnly)).toBe('artist negative');
  });

  it('纯空白等同留空;方案旧值不能截胡官方回落', () => {
    const s = nai({
      artist: { ...preset, quality: '  \n ', negative: '\t' },
      qualityTags: 'plan quality',
      undesiredContent: 'plan negative',
    });
    expect(fullPositivePrompt(s, '1girl')).toBe(
      'artist:a, 1girl, location, very aesthetic, masterpiece, no text',
    );
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired('nai-diffusion-4-5-full'));
  });
});

describe('NAI V5 support', () => {
  it('uses official model defaults and params_version 4', () => {
    for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated'] as const) {
      expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
      expect(naiDefaultUndesired(model)).toContain('dithering, halftone, screentone');
      const params = buildNaiParameters(nai({ model }), { prompt: '1girl', seed: 42 });
      expect(params.params_version).toBe(4);
      expect(params.v4_prompt).toBeTruthy();
      expect(params.skip_cfg_above_sigma).toBeNull();
      expect(params.sampler).toBe('k_euler');
    }
    const fallback = buildNaiParameters(nai({ model: 'nai-diffusion-5-full', sampler: 'ddim_v3' }), {
      prompt: '1girl',
      seed: 42,
    });
    expect(fallback.sampler).toBe('k_euler_ancestral');
  });

  it('V5 Full 默认负面只排缺陷,不再禁题材/风格/身材/画师', () => {
    // 老版在官方基线上串过一大串社区词,把 chibi、大胸、暗调、具体画师名等都禁了,
    // 会跟正向词与画师串长期打架(原作者已声明弃用)。这里锁死:通用默认不碰题材偏好。
    const neg = naiDefaultUndesired('nai-diffusion-5-full');
    // 官方基线原样保留(V5 调参依赖它,面板也靠这段认出「未自定义」)
    expect(neg).toContain('worst quality, bad quality, jpeg artifacts');
    expect(neg).toContain('dithering, halftone, screentone');
    for (const banned of [
      'chibi',
      'large breasts',
      'huge breasts',
      'dark',
      'high contrast',
      'artist:',
      'artist collaboration',
      '4koma',
      'oekaki',
      'black face',
      'extra people',
      'honey',
      'tight pants',
      'childish',
    ]) {
      expect(neg).not.toContain(banned);
    }
  });

  // 官方前端对 Medium 档隐藏步数/采样器/负面词/Rescale,发请求时强行改写;照抄同一口径
  it('V5 Full Medium 按官方锁死参数:14 步、Euler Ancestral、无 Rescale、负面词恒为官方 Heavy', () => {
    const model = 'nai-diffusion-5-full-medium' as const;
    const s = nai({
      model,
      steps: 28,
      sampler: 'k_dpmpp_2m',
      cfgRescale: 0.4,
      artist: { id: 'art_a', name: 'A', prompt: '', quality: '', negative: 'my negative' },
    });
    const params = buildNaiParameters(s, { prompt: '1girl', seed: 42 });
    expect(params).toMatchObject({ params_version: 4, steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0 });
    expect(params.skip_cfg_above_sigma).toBeNull();
    // 官方 Heavy 原文,不串 5-full 的插件精选层;用户自填的不发
    expect(fullNegativePrompt(s)).toBe(naiDefaultUndesired(model));
    expect(fullNegativePrompt(s)).not.toContain('my negative');
    expect(fullNegativePrompt(s)).not.toContain('plastic skin');
    expect(naiDefaultQualityTags(model)).toBe('very aesthetic, masterpiece, no text');
    expect(naiFixedSettings(model)).toEqual({ steps: 14, sampler: 'k_euler_ancestral' });
    expect(naiFixedSettings('nai-diffusion-5-full')).toBeNull();
    // 与官方同口径:vibe 编码键归 v5full;角色提示照常走 V5 协议
    expect(vibeModelKey(model)).toBe('v5full');
    expect(naiSupportsCharacterPrompts(model)).toBe(true);
    // 正面质量词不受锁定影响,画师串自定义照常生效
    const artist = { id: 'art_a', name: 'A', prompt: '', quality: 'my quality', negative: 'my negative' };
    expect(fullPositivePrompt(nai({ model, artist }), '1girl')).toBe('1girl, my quality');
  });

  it('maps Base Tag + NL and native Character Prompts into the V5 caption schema', () => {
    const settings = nai({
      model: 'nai-diffusion-5-full',
      artist: { id: 'artist', name: 'Artist', prompt: 'artist:test', quality: 'very aesthetic', negative: '' },
    });
    const params = buildNaiParameters(settings, {
      prompt: '2girls, classroom, sunset',
      nl: 'Two girls in a sunset classroom.',
      characters: [
        { name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left, waving.' },
        { name: 'B', tag: 'girl, silver hair, red dress', nl: '' },
      ],
      seed: 42,
    });
    const positive = params.v4_prompt as {
      caption: { base_caption: string; char_captions: Array<{ char_caption: string; centers: unknown[] }> };
      use_coords: boolean;
      use_order: boolean;
    };
    const negative = params.v4_negative_prompt as {
      caption: { char_captions: Array<{ char_caption: string; centers: unknown[] }> };
    };
    expect(positive.caption.base_caption).toBe(
      'artist:test, 2girls, classroom, sunset, very aesthetic. Two girls in a sunset classroom.',
    );
    expect(positive.caption.char_captions).toEqual([
      { char_caption: 'girl, black hair, white dress. On the left, waving.', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: 'girl, silver hair, red dress', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(negative.caption.char_captions).toEqual([
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
      { char_caption: '', centers: [{ x: 0.5, y: 0.5 }] },
    ]);
    expect(positive.use_coords).toBe(false);
    expect(positive.use_order).toBe(true);
  });

  // V5 不支持 Vibe Transfer:有 v5 编码也不发,整组记为跳过
  it('skips vibes on V5 even when a V5 encoding exists', () => {
    expect(vibeModelKey('nai-diffusion-5-full')).toBe('v5full');
    expect(vibeModelKey('nai-diffusion-5-curated')).toBe('v5curated');
    expect(naiSupportsVibes('nai-diffusion-5-full')).toBe(false);
    expect(naiSupportsVibes('nai-diffusion-4-5-full')).toBe(true);
    const settings = nai({ model: 'nai-diffusion-5-full', vibes: [vibe({ name: 'V5 vibe' })] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const data = vibeData({ encodings: { v5full: { encoding: 'djU=', infoExtracted: 1 } } });
    expect(applyVibes(params, settings, new Map([['v1', data]])).skipped).toEqual(['V5 vibe']);
    expect(params.reference_image_multiple_cached ?? []).toEqual([]);
  });

  // 回归锁:char_captions 所在字段本就叫 v4_prompt,这套结构是 V4 时代的协议,V5 只是继承。
  // 曾经按 isNai5 卡过,4.5 明明支持却一条角色提示都发不出去(角色外貌全糊进 Base)。
  // 边界在 4.5 而非整个 v4 系:自然语言是 4.5 引入的,原版 NAI4 只吃 tag。
  it('sends native Character Prompts on 4.5 as well as V5, but not on plain NAI 4', () => {
    const values = {
      prompt: '2girls, classroom',
      nl: 'Two girls in a classroom.',
      characters: [{ name: 'A', tag: '1girl, black hair, white dress', nl: 'On the left.' }],
      seed: 1,
    };
    const captionsOf = (model: NaiModel) =>
      (
        buildNaiParameters(nai({ model }), values).v4_prompt as {
          caption: { base_caption: string; char_captions: Array<{ char_caption: string }> };
        }
      ).caption;

    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions.map(c => c.char_caption)]).toEqual([
        model,
        ['girl, black hair, white dress. On the left.'],
      ]);
      // nl 拼接同样开放到 4.5:句点分隔接在 tag 串之后
      expect([model, caption.base_caption.endsWith('. Two girls in a classroom.')]).toEqual([model, true]);
    }

    // 原版 NAI4 保持单串形态:角色提示与 nl 都不发
    for (const model of ['nai-diffusion-4-full', 'nai-diffusion-4-curated-preview'] as const) {
      const caption = captionsOf(model);
      expect([model, caption.char_captions]).toEqual([model, []]);
      expect([model, caption.base_caption.includes('Two girls in a classroom.')]).toEqual([model, false]);
    }
  });
});

describe('buildNaiParameters', () => {
  it('v4 系带 v4_prompt 结构', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 42 });
    expect(p.seed).toBe(42);
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
    const v4 = p.v4_prompt as { caption: { base_caption: string }; use_order: boolean };
    expect(v4.caption.base_caption).toContain('1girl');
    expect(v4.use_order).toBe(true);
    expect(p.reference_image_multiple_cached).toEqual([]);
    expect(p.v4_negative_prompt).toBeTruthy();
    expect(p.ucPreset).toBe(3);
    expect(p.qualityToggle).toBe(true);
  });

  it('NAI3 不带 v4 结构,带原图参考数组与 sm 开关', () => {
    const p = buildNaiParameters(nai({ model: 'nai-diffusion-3' }), { prompt: '1girl', seed: 1 });
    expect(p.v4_prompt).toBeUndefined();
    expect(p.reference_image_multiple).toEqual([]);
    expect(p.reference_information_extracted_multiple).toEqual([]);
    expect(p.sm).toBe(false);
    expect(p.reference_image_multiple_cached).toBeUndefined();
  });

  it('v4_prompt 的 base_caption 与 fullPositivePrompt 同源(含画师串)', () => {
    // 顶层 input(generateNaiImage)与 parameters.v4_prompt 各拼一次的话,NAI3 读 input、
    // NAI4/4.5 读 v4_prompt,两者会拿到不同提示词且只在 NAI3 上暴露。此断言把「同源」钉死:
    // 任何拼装改动都必须留在 fullPositivePrompt 内部,不能在调用点单独加料。
    const s = nai({
      artist: { id: 'art_a', name: 'A', prompt: 'artist:a', quality: '', negative: '' },
    });
    const p = buildNaiParameters(s, { prompt: '1girl', seed: 1 });
    const v4 = p.v4_prompt as { caption: { base_caption: string } };
    expect(v4.caption.base_caption).toBe(fullPositivePrompt(s, '1girl'));
    expect(v4.caption.base_caption.startsWith('artist:a, 1girl')).toBe(true);
  });

  it('k_euler_ancestral 附加 brownian 修正', () => {
    const p = buildNaiParameters(nai({ sampler: 'k_euler_ancestral' }), { prompt: 'x', seed: 1 });
    expect(p.prefer_brownian).toBe(true);
    expect(p.deliberate_euler_ancestral_bug).toBe(false);
  });

  it('横屏画面取横屏尺寸,skip_cfg_above_sigma 随像素量同步变化', () => {
    const portrait = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    const landscape = buildNaiParameters(nai(), { prompt: '2girls', seed: 1, size: 'landscape' });
    expect(landscape.width).toBe(1216);
    expect(landscape.height).toBe(832);
    // 832×1216 与 1216×832 像素量相同,sigma 也应相同(证明它确实按尺寸推导)
    expect(landscape.skip_cfg_above_sigma).toBe(portrait.skip_cfg_above_sigma);

    const bigLandscape = buildNaiParameters(nai({ landscapeSize: '1536×1024' }), {
      prompt: '2girls',
      seed: 1,
      size: 'landscape',
    });
    expect(bigLandscape.width).toBe(1536);
    expect(Number(bigLandscape.skip_cfg_above_sigma)).toBeGreaterThan(
      Number(portrait.skip_cfg_above_sigma),
    );
  });

  it('缺 size 时按竖屏出图(与改动前的固定默认一致)', () => {
    const p = buildNaiParameters(nai(), { prompt: '1girl', seed: 1 });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('对应方向未填时回落内置竖屏默认', () => {
    const p = buildNaiParameters(nai({ landscapeSize: '' }), { prompt: 'x', seed: 1, size: 'landscape' });
    expect(p.width).toBe(832);
    expect(p.height).toBe(1216);
  });

  it('固定种子优先于随机', () => {
    const p = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x' });
    expect(p.seed).toBe(123);
    const p2 = buildNaiParameters(nai({ seed: 123 }), { prompt: 'x', seed: 7 });
    expect(p2.seed).toBe(7);
  });
});

describe('skipCfgAboveSigma', () => {
  it('关 variety 时为 null', () => {
    expect(skipCfgAboveSigma(832, 1216, 'nai-diffusion-4-5-full', false)).toBeNull();
  });

  it('4.5 用 58,其余用 19', () => {
    const v45 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-5-full', true)!;
    const v4 = skipCfgAboveSigma(1024, 1024, 'nai-diffusion-4-full', true)!;
    expect(v45 / v4).toBeCloseTo(58 / 19, 5);
  });
});

describe('applyVibes', () => {
  it('NAI4/4.5:编码数据进 cached,强度并进 strength 数组', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(params, nai({ vibes: [vibe()] }), new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    // 随图记录的是面板配置强度与实际发送强度
    expect(applied).toEqual([
      { id: 'v1', name: '测试Vibe', group: '', strength: 0.6, effectiveStrength: 0.6 },
    ]);
    const cached = params.reference_image_multiple_cached as { cache_secret_key: string; data: string }[];
    expect(cached).toHaveLength(1);
    expect(cached[0].data).toBe('ZW5jb2Rpbmc=');
    expect(cached[0].cache_secret_key).toBeTruthy();
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('缺当前模型编码的 vibe 被跳过并返回名字', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied, skipped } = applyVibes(
      params,
      nai({ vibes: [vibe({ name: '旧模型Vibe', modelKeys: ['v3'] })] }),
      new Map([['v1', vibeData({ encodings: { v3: { encoding: 'eQ==', infoExtracted: 1 } } })]]),
    );
    expect(skipped).toEqual(['旧模型Vibe']);
    expect(applied).toEqual([]);
    expect(params.reference_image_multiple_cached).toEqual([]);
  });

  it('强度总和超过 1 且开归一化时按比例压回 1', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    const { applied } = applyVibes(
      params,
      nai({
        vibes: [vibe({ id: 'a', strength: 0.8 }), vibe({ id: 'b', strength: 0.6 })],
      }),
      new Map([
        ['a', vibeData()],
        ['b', vibeData()],
      ]),
    );
    const strengths = params.reference_strength_multiple as number[];
    expect(strengths[0] + strengths[1]).toBeCloseTo(1, 6);
    // 记录里配置值保持原样，实际发送值反映归一化结果
    expect(applied.map(v => v.strength)).toEqual([0.8, 0.6]);
    expect(applied[0].effectiveStrength).toBeCloseTo(0.8 / 1.4, 6);
    expect(applied[1].effectiveStrength).toBeCloseTo(0.6 / 1.4, 6);
  });

  it('NAI3:参考原图进 reference_image_multiple', () => {
    const settings = nai({ model: 'nai-diffusion-3', vibes: [vibe()] });
    const params = buildNaiParameters(settings, { prompt: 'x', seed: 1 });
    const { skipped } = applyVibes(params, settings, new Map([['v1', vibeData()]]));
    expect(skipped).toEqual([]);
    expect(params.reference_image_multiple).toEqual(['aW1hZ2U=']);
    expect(params.reference_information_extracted_multiple).toEqual([1]);
    expect(params.reference_strength_multiple).toEqual([0.6]);
  });

  it('没勾选任何 vibe(vibes 为空)时什么都不加', () => {
    const params = buildNaiParameters(nai(), { prompt: 'x', seed: 1 });
    expect(applyVibes(params, nai({ vibes: [] }), new Map([['v1', vibeData()]]))).toEqual({
      applied: [],
      skipped: [],
    });
    expect(params.reference_image_multiple_cached).toEqual([]);
  });
});

describe('vibeModelKey', () => {
  it('按模型映射官方 key', () => {
    expect(vibeModelKey('nai-diffusion-4-5-full')).toBe('v4-5full');
    expect(vibeModelKey('nai-diffusion-4-5-curated')).toBe('v4-5curated');
    expect(vibeModelKey('nai-diffusion-4-full')).toBe('v4full');
    expect(vibeModelKey('nai-diffusion-4-curated-preview')).toBe('v4curated');
    expect(vibeModelKey('nai-diffusion-3')).toBe('v3');
  });
});

describe('parseNaiv4vibe', () => {
  it('解析官方格式', () => {
    const text = JSON.stringify({
      identifier: 'novelai-vibe-transfer',
      version: 1,
      image: 'aW1hZ2U=',
      name: 'abc123-def456',
      thumbnail: 'data:image/png;base64,xx',
      encodings: {
        'v4-5full': {
          k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
        },
      },
      importInfo: { model: 'nai-diffusion-4-5-full', information_extracted: 1, strength: 0.7 },
    });
    const v = parseNaiv4vibe(text);
    expect(v.name).toBe('abc123-def456');
    expect(v.encodings['v4-5full'].encoding).toBe('ZW5jb2Rpbmc=');
    expect(v.strength).toBe(0.7);
  });

  it('缺 strength 字段回落 0.6,不静默变成强度 0', () => {
    // 回归:旧实现走 Number(v),而 Number(null) / Number('') 都是 0 ——
    // vibe 会以「强度 0」导入,挂上了却对画面毫无影响,且极难排查。
    const build = (importInfo: unknown) =>
      JSON.stringify({
        identifier: 'novelai-vibe-transfer',
        version: 1,
        image: 'aW1hZ2U=',
        encodings: {
          'v4-5full': {
            k: { encoding: 'ZW5jb2Rpbmc=', params: { information_extracted: 1 } },
          },
        },
        importInfo,
      });
    expect(parseNaiv4vibe(build({ model: 'nai-diffusion-4-5-full' })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: null })).strength).toBe(0.6);
    expect(parseNaiv4vibe(build({ strength: '' })).strength).toBe(0.6);
  });

  it('拒绝非 vibe JSON', () => {
    expect(() => parseNaiv4vibe('{"foo":1}')).toThrow(/标识/);
    expect(() => parseNaiv4vibe('not json')).toThrow(NaiError);
  });
});

describe('unzipNaiImage', () => {
  it('解出 zip 内第一张图', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = unzipNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('非 zip 数据报友好错误', () => {
    expect(() => unzipNaiImage(strToU8('not a zip').buffer as ArrayBuffer)).toThrow(NaiError);
  });
});

describe('decodeNaiImage(官方 zip + 第三方 JSON 双口径)', () => {
  // 真 PNG 头 + 几个字节:格式按魔数认,不看接口自报的 image_format
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
  const pngB64 = btoa(String.fromCharCode(...pngBytes));
  const asBody = (text: string) => strToU8(text).buffer as ArrayBuffer;

  it('官方 zip 照旧解', () => {
    const zipped = zipSync({ 'image_0.png': strToU8('fake-png-bytes') });
    const { base64, filename } = decodeNaiImage(zipped.buffer as ArrayBuffer);
    expect(filename).toBe('image_0.png');
    expect(atob(base64)).toBe('fake-png-bytes');
  });

  it('new-api 系 {job, images:[b64], image_format}', () => {
    const body = asBody(JSON.stringify({ job: { steps: 28 }, images: [pngB64], image_format: 'png' }));
    const { base64, filename } = decodeNaiImage(body);
    expect(base64).toBe(pngB64);
    expect(filename).toBe('image_0.png');
  });

  it('OpenAI 系 {data:[{b64_json}]}', () => {
    const body = asBody(JSON.stringify({ created: 1, data: [{ b64_json: pngB64 }] }));
    expect(decodeNaiImage(body).base64).toBe(pngB64);
  });

  it('data URI 前缀会被剥掉', () => {
    const body = asBody(JSON.stringify({ images: [`data:image/png;base64,${pngB64}`] }));
    expect(decodeNaiImage(body).base64).toBe(pngB64);
  });

  it('JPEG / WebP 按魔数落到正确扩展名', () => {
    const jpeg = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 1));
    expect(decodeNaiImage(asBody(JSON.stringify({ images: [jpeg] }))).filename).toBe('image_0.jpeg');
    const webp = btoa(String.fromCharCode(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50));
    expect(decodeNaiImage(asBody(JSON.stringify({ images: [webp] }))).filename).toBe('image_0.webp');
  });

  it('既非 zip 也无图片字段 → 报错', () => {
    expect(() => decodeNaiImage(asBody('{"error":"boom"}'))).toThrow(NaiError);
    expect(() => decodeNaiImage(asBody('<html>oops</html>'))).toThrow(NaiError);
  });
});

describe('naiRandomSeed', () => {
  it('32 位无符号整数', () => {
    const s = naiRandomSeed();
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(2 ** 32);
  });
});

describe('内置画师串配方(只读、随版本更新、不进 settings)', () => {
  // 引用解析(方案 artistId → 用户库 / 内置库 / 悬空 = null)在 settings.naiArtistFor,
  // 见 settings.naiPlans.test.ts;这里只锁「解析出内置条目后」的拼装。
  it('方案选中内置条目时,画师串照常拼在最前', () => {
    const s = nai({ artist: BUILTIN_NAI_ARTISTS[0] });
    expect(naiArtistPrompt(s)).toBe(BUILTIN_NAI_ARTISTS[0].prompt.trim());
    expect(fullPositivePrompt(s, '1girl')).toBe(
      `${BUILTIN_NAI_ARTISTS[0].prompt.trim()}, 1girl, location, very aesthetic, masterpiece, no text`,
    );
  });

  it('isBuiltinNaiArtist:bi_ 前缀命中,用户条目(art_*)不命中', () => {
    expect(isBuiltinNaiArtist('bi_default')).toBe(true);
    expect(isBuiltinNaiArtist('art_abc')).toBe(false);
    expect(isBuiltinNaiArtist('')).toBe(false);
  });
});

describe('testNaiConnection:官方订阅 / 中转站模型列表 / CORS', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const html = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });

  it('官方站:订阅接口报出等级', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ tier: 3, active: true })),
    );
    const result = await testNaiConnection({ url: 'https://image.novelai.net/ai/generate-image', key: 'k' });
    expect(result.message).toBe('连接正常:Opus');
  });

  it('中转站把未知路径回落成前端 HTML → 退到 /v1/models,用模型数当凭据', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        return String(url).endsWith('/v1/models')
          ? json({ data: [{ id: 'nai-diffusion-5-full' }, { id: 'nai-diffusion-4-5-curated' }] })
          : html();
      }),
    );
    const result = await testNaiConnection({ url: 'https://api.rinko.ai/v1/nai/generate-image', key: 'k' });
    expect(result.message).toContain('2 个模型');
    // 订阅接口在站点根下,模型列表也取站点根 —— 与生图端点是不是 /v1/nai 无关
    expect(calls).toEqual(['https://api.rinko.ai/user/subscription', 'https://api.rinko.ai/v1/models']);
  });

  it('两处都没有 → 只报地址可达,不再出现 Tier undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const result = await testNaiConnection({ url: 'https://mirror.example.com/ai/generate-image', key: 'k' });
    expect(result.message).toContain('地址可达');
    expect(result.message).not.toContain('undefined');
  });

  it('401 → 报 Key 错,且不再往下探', async () => {
    const fetchMock = vi.fn(async () => json({ message: 'invalid token' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(testNaiConnection({ url: 'https://x.example.com/ai/generate-image', key: 'k' })).rejects.toThrow(
      /API Key/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetch 抛 TypeError(浏览器 CORS)→ 提示反代,而不是光甩一句 Failed to fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(
      testNaiConnection({ url: 'https://api.rinko.ai/v1/nai/generate-image', key: 'k' }),
    ).rejects.toThrow(/反代/);
  });
});

describe('生图请求:网关不认 stream 时摘字段重试', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('首个请求 502 → 摘掉 stream 重试一次,解出 base64 JSON', async () => {
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9));
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (bodies.length === 1) return new Response('error code: 502', { status: 502 });
        return new Response(JSON.stringify({ images: [png], image_format: 'png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const output = await generateNaiImage(nai({ url: 'https://gw.example.com/v1/nai/generate-image', key: 'k' }), {
      prompt: '1girl',
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[0].parameters).toHaveProperty('stream');
    expect(bodies[1].parameters).not.toHaveProperty('stream');
    expect(output.result.url.startsWith('data:image/png;base64,')).toBe(true);
  });
});

describe('桥接地址(同源前缀 + 整段上游 URL)', () => {
  // ST 服务端插件 / cors-anywhere 的写法:前缀留在 ST 上,里层是真正的上游地址
  const bridge = 'http://127.0.0.1:8000/api/plugins/nai-bridge/https://api.rinko.ai/v1/nai/generate-image';
  const at = (path: string) => `http://127.0.0.1:8000/api/plugins/nai-bridge/https://api.rinko.ai${path}`;

  it('生图端点:前缀 + 上游地址原样透传', () => {
    expect(naiEndpoint(bridge, 'generate-image')).toBe(bridge);
  });

  it('encode-vibe:只换里层末段,前缀不动', () => {
    expect(naiEndpoint(bridge, 'encode-vibe')).toBe(at('/v1/nai/encode-vibe'));
  });

  it('订阅端点:取里层站点根,前缀跟着带上', () => {
    expect(naiEndpoint(bridge, 'user/subscription')).toBe(at('/user/subscription'));
  });

  it('naiOrigin:返回「前缀 + 里层站点根」,供测试连接拼 /v1/models', () => {
    expect(naiOrigin(bridge)).toBe(at(''));
    expect(naiOrigin('https://api.rinko.ai/v1/nai/generate-image')).toBe('https://api.rinko.ai');
    expect(naiOrigin('   ')).toBeNull();
  });

  it('普通地址不会被误判成桥接', () => {
    expect(naiEndpoint('https://api.rinko.ai/v1/nai/generate-image', 'generate-image')).toBe(
      'https://api.rinko.ai/v1/nai/generate-image',
    );
  });
});

describe('鉴权头:桥接模式不与 ST 的 Basic 冲突', () => {
  afterEach(() => vi.unstubAllGlobals());

  const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
  const firstCallHeaders = async (url: string) => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
        seen.push({ ...(init.headers ?? {}) });
        return new Response(JSON.stringify({ images: [png], image_format: 'png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await generateNaiImage(nai({ url, key: 'sk-test' }), { prompt: '1girl' });
    return seen[0];
  };

  it('桥接地址:Key 走 X-NAI-Key,Authorization 留给浏览器带 Basic', async () => {
    const headers = await firstCallHeaders(
      'http://localhost:8000/api/plugins/nai-bridge/https://api.rinko.ai/v1/nai/generate-image',
    );
    expect(headers['X-NAI-Key']).toBe('sk-test');
    // 抢了 Authorization 的话,ST 的 basicAuth 判定 scheme 不是 Basic → 每次请求弹一次密码框
    expect(headers.Authorization).toBeUndefined();
  });

  it('普通地址:仍是标准的 Authorization: Bearer', async () => {
    const headers = await firstCallHeaders('https://image.novelai.net/ai/generate-image');
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['X-NAI-Key']).toBeUndefined();
  });
});

describe('桥接地址的相对写法(按页面同源解析)', () => {
  // 页面可能是 localhost、局域网 IP 或域名:写死主机就会跨源,浏览器不带 Basic、还要吃 CORS
  const rel = '/api/plugins/nai-bridge/https://api.rinko.ai/v1/nai/generate-image';
  const at = (path: string) => `/api/plugins/nai-bridge/https://api.rinko.ai${path}`;

  it('生图端点原样保留', () => {
    expect(naiEndpoint(rel, 'generate-image')).toBe(rel);
  });

  it('encode-vibe / 订阅端点同样只改里层', () => {
    expect(naiEndpoint(rel, 'encode-vibe')).toBe(at('/v1/nai/encode-vibe'));
    expect(naiEndpoint(rel, 'user/subscription')).toBe(at('/user/subscription'));
  });

  it('naiOrigin 返回相对前缀 + 里层站点根', () => {
    expect(naiOrigin(rel)).toBe(at(''));
  });

  it('裸 / 报错', () => {
    expect(() => naiEndpoint('/', 'generate-image')).toThrow(NaiError);
  });

  it('相对桥接地址仍走 X-NAI-Key', async () => {
    const seen: Record<string, string>[] = [];
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { headers?: Record<string, string> } = {}) => {
        seen.push({ ...(init.headers ?? {}) });
        return new Response(JSON.stringify({ images: [png], image_format: 'png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await generateNaiImage(nai({ url: rel, key: 'sk-test' }), { prompt: '1girl' });
    expect(seen[0]['X-NAI-Key']).toBe('sk-test');
    expect(seen[0].Authorization).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe('桥接地址的无斜杠写法(给会合并 // 的反向代理)', () => {
  const rel = '/api/plugins/nai-bridge/https/api.rinko.ai/v1/nai/generate-image';
  const at = (path: string) => `/api/plugins/nai-bridge/https/api.rinko.ai${path}`;

  it('生图端点原样保留', () => {
    expect(naiEndpoint(rel, 'generate-image')).toBe(rel);
  });

  it('encode-vibe / 订阅端点只改里层,写法不变', () => {
    expect(naiEndpoint(rel, 'encode-vibe')).toBe(at('/v1/nai/encode-vibe'));
    expect(naiEndpoint(rel, 'user/subscription')).toBe(at('/user/subscription'));
  });

  it('naiOrigin 返回同写法的站点根', () => {
    expect(naiOrigin(rel)).toBe(at(''));
  });

  it('绝对前缀 + 无斜杠形式同样支持', () => {
    const absolute = 'http://192.168.1.5:8000/api/plugins/nai-bridge/https/api.rinko.ai/v1/nai/generate-image';
    expect(naiEndpoint(absolute, 'encode-vibe')).toBe(
      'http://192.168.1.5:8000/api/plugins/nai-bridge/https/api.rinko.ai/v1/nai/encode-vibe',
    );
  });

  it('http 目标也认', () => {
    expect(naiOrigin('/api/plugins/nai-bridge/http/api.rinko.ai/v1/nai/generate-image')).toBe(
      '/api/plugins/nai-bridge/http/api.rinko.ai',
    );
  });
});

describe('桥接地址 404 必须报错，不能假通过', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('插件没加载时给出明确提示，而不是「地址可达」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><h1>Not Found</h1>', { status: 404 })),
    );
    await expect(
      testNaiConnection({
        url: '/api/plugins/nai-bridge/https/api.rinko.ai/v1/nai/generate-image',
        key: 'k',
      }),
    ).rejects.toThrow(/桥接路由不存在/);
  });

  it('普通地址仍是「地址可达」兜底', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const result = await testNaiConnection({ url: 'https://mirror.example.com/ai/generate-image', key: 'k' });
    expect(result.message).toContain('地址可达');
  });
});
