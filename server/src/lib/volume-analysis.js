import { resolveModel } from '../lib/ai-provider.js';
import { regionToLocationCode, languageToCode } from '../lib/dataforseo-codes.js';
import supabaseAdmin from '../config/supabase.js';
import { AI_VOLUME_MULTIPLIER, extractIntentKeywords } from '../lib/intent-extraction.js';
import { getSearchVolumes } from './dataforseo.js';
import logger from './logger.js';

export function mapVolumeRow(saved) {
  return {
    id: saved.id,
    promptId: saved.prompt_id,
    intent: saved.intent,
    keywords: saved.keywords,
    googleVolumes: saved.google_volumes,
    totalGoogleVolume: saved.total_google_volume,
    aiVolumeMultiplier: parseFloat(saved.ai_volume_multiplier),
    estAiVolume: saved.est_ai_volume,
    competitionIndex: saved.competition_index ?? null,
    competition: saved.competition ?? null,
    locationCode: saved.location_code,
    languageCode: saved.language_code,
    fetchedAt: saved.fetched_at,
  };
}

export async function fetchAndSaveVolumes(promptId, keywords, intent, locationCode, languageCode) {
  const volumes = await getSearchVolumes(keywords, {
    locationCode: locationCode || undefined,
    languageCode: languageCode || undefined,
  });

  // google_volumes stays a { keyword: number } map for the UI. Competition is
  // aggregated per prompt as a volume-weighted average of the keyword indices.
  const googleVolumes = {};
  let totalGoogleVolume = 0;
  let competitionWeightedSum = 0;
  let competitionWeight = 0;
  for (const [keyword, data] of Object.entries(volumes)) {
    googleVolumes[keyword] = data.volume;
    totalGoogleVolume += data.volume;
    if (data.competitionIndex !== null && data.competitionIndex !== undefined) {
      competitionWeightedSum += data.competitionIndex * data.volume;
      competitionWeight += data.volume;
    }
  }

  const competitionIndex =
    competitionWeight > 0 ? Math.round(competitionWeightedSum / competitionWeight) : null;
  const competition =
    competitionIndex === null
      ? null
      : competitionIndex <= 33
        ? 'LOW'
        : competitionIndex <= 66
          ? 'MEDIUM'
          : 'HIGH';

  const estAiVolume = Math.round(totalGoogleVolume * AI_VOLUME_MULTIPLIER);

  const { data: saved, error: dbError } = await supabaseAdmin
    .from('prompt_volumes')
    .upsert(
      {
        prompt_id: promptId,
        intent,
        keywords,
        google_volumes: googleVolumes,
        total_google_volume: totalGoogleVolume,
        ai_volume_multiplier: AI_VOLUME_MULTIPLIER,
        est_ai_volume: estAiVolume,
        competition_index: competitionIndex,
        competition,
        location_code: locationCode || null,
        language_code: languageCode || null,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'prompt_id' },
    )
    .select()
    .single();

  if (dbError) throw new Error(dbError.message);
  return saved;
}

export async function analyzeBrandVolumes(brandId, { force = false } = {}) {
  const { data: brand, error: brandError } = await supabaseAdmin
    .from('brands')
    .select('region, language')
    .eq('id', brandId)
    .maybeSingle();

  if (brandError) {
    throw new Error(`Failed to fetch brand: ${brandError.message}`);
  }
  if (!brand) {
    throw new Error(`Brand ${brandId} not found`);
  }

  const resolvedLocationCode = brand.region ? regionToLocationCode(brand.region) : undefined;

  const resolvedLanguageCode = brand.language ? languageToCode(brand.language) : undefined;
  const { data: promptSets, error: psError } = await supabaseAdmin
    .from('prompt_sets')
    .select('id')
    .eq('brand_id', brandId);

  if (psError) {
    throw new Error(`Failed to fetch prompt sets: ${psError.message}`);
  }

  if (!promptSets || promptSets.length === 0) {
    return [];
  }

  const setIds = promptSets.map((ps) => ps.id);

  const { data: prompts, error: pError } = await supabaseAdmin
    .from('prompts')
    .select('id, text')
    .in('prompt_set_id', setIds);
  if (pError) {
    throw new Error(`Failed to fetch prompts: ${pError.message}`);
  }

  if (!prompts || prompts.length === 0) {
    return [];
  }

  const promptIds = prompts.map((p) => p.id);

  const existingMap = {};

  if (!force) {
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from('prompt_volumes')
      .select('prompt_id, intent, keywords')
      .in('prompt_id', promptIds);

    if (existingError) {
      throw new Error(`Failed to fetch existing volumes: ${existingError.message}`);
    }

    if (existingRows) {
      for (const row of existingRows) {
        if (row.keywords?.length) {
          existingMap[row.prompt_id] = {
            intent: row.intent,
            keywords: row.keywords,
          };
        }
      }
    }
  }

  const aiModel = resolveModel();
  const results = [];

  for (const { id: promptId, text: promptText } of prompts) {
    try {
      let intent;
      let keywords;

      const cached = existingMap[promptId];
      if (cached) {
        intent = cached.intent;
        keywords = cached.keywords;
      } else {
        const intentResult = await extractIntentKeywords(promptText, aiModel);
        intent = intentResult.intent;
        keywords = intentResult.keywords;
      }

      const saved = await fetchAndSaveVolumes(
        promptId,
        keywords,
        intent,
        resolvedLocationCode,
        resolvedLanguageCode,
      );
      results.push(mapVolumeRow(saved));
    } catch (err) {
      logger.error({err, promptId},'volume analysis failed for prompt');
      
      results.push({ promptId, error: err.message });
    }
  }
  return results;
}
