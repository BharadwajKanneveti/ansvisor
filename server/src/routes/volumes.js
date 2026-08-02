import { Router } from 'express';
import { resolveModel } from '../lib/ai-provider.js';
import { regionToLocationCode, languageToCode } from '../lib/dataforseo-codes.js';
import {
  requireFeature,
  enforceVolumeQuota,
  getVolumeQuotaStatus,
  PlanLimitError,
} from '../lib/plan-guard.js';
import supabaseAdmin from '../config/supabase.js';
import { assertBrandAccess, assertPromptAccess } from '../lib/access.js';
import { extractIntentKeywords } from '../lib/intent-extraction.js';
import { mapVolumeRow, fetchAndSaveVolumes } from '../lib/volume-analysis.js';
import { analyzeBrandVolumes } from '../lib/volume-analysis.js';

const router = Router();

/**
 * POST /api/volumes/analyze
 * First-time analysis: LLM extracts intent + keywords, then fetches volumes.
 * If keywords already exist for this prompt, only refreshes volumes (skips LLM).
 * Pass force=true to re-generate keywords via LLM even if they exist.
 */
router.post('/analyze', requireFeature('prompt_volumes'), async (req, res) => {
  try {
    const { remaining, orgId } = await enforceVolumeQuota(req.user.id);

    const { promptId, promptText, locationCode, languageCode, model, force } = req.body;

    if (!promptId || !promptText) {
      return res.status(400).json({ error: 'promptId and promptText are required' });
    }

    await assertPromptAccess(promptId, req.user.id);

    let resolvedLocationCode = locationCode;
    let resolvedLanguageCode = languageCode;
    if (resolvedLocationCode == null || resolvedLanguageCode == null) {
      const { data: brandRow } = await supabaseAdmin
        .from('prompts')
        .select('prompt_sets!inner(brands!inner(region, language))')
        .eq('id', promptId)
        .maybeSingle();
      const brand = brandRow?.prompt_sets?.brands;
      if (brand) {
        if (resolvedLocationCode == null) {
          resolvedLocationCode = regionToLocationCode(brand.region);
        }
        if (resolvedLanguageCode == null) {
          resolvedLanguageCode = languageToCode(brand.language);
        }
      }
    }

    let intent;
    let keywords;

    if (!force) {
      const { data: existing } = await supabaseAdmin
        .from('prompt_volumes')
        .select('intent, keywords')
        .eq('prompt_id', promptId)
        .single();

      if (existing?.keywords?.length) {
        intent = existing.intent;
        keywords = existing.keywords;
      }
    }

    if (!keywords) {
      const aiModel = resolveModel(model);
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

    if (orgId) {
      await supabaseAdmin.from('volume_usage').insert({
        organization_id: orgId,
        action: 'analyze',
        prompt_count: 1,
      });
    }

    const result = mapVolumeRow(saved);
    return res.json({ ...result, remaining: remaining === -1 ? -1 : remaining - 1 });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return res.status(error.statusCode).json({
        success: false,
        error: 'quota_exceeded',
        message: error.message,
      });
    }
    req.log.error({ err: error }, 'volume analysis error');
    return res.status(error.status || 500).json({
      error: 'Failed to analyze prompt volume',
      details: error.message,
    });
  }
});

/**
 * POST /api/volumes/analyze-batch
 * Batch analysis. Uses saved keywords when available, calls LLM only for new prompts.
 * Pass force=true to re-generate all keywords via LLM.
 */
router.post('/analyze-batch', requireFeature('prompt_volumes'), async (req, res) => {
  try {
    const { remaining, orgId } = await enforceVolumeQuota(req.user.id);

    const { prompts, force } = req.body;

    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: 'prompts array is required and must not be empty' });
    }

    if (prompts.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 prompts per batch' });
    }

    const promptIds = prompts.map((p) => p.promptId);

    await assertPromptAccess(promptIds, req.user.id);

    const { data: brandRow, error: brandError } = await supabaseAdmin
      .from('prompts')
      .select('prompt_sets!inner(brands!inner(id))')
      .in('id', promptIds)
      .limit(1)
      .maybeSingle();

    if (brandError) {
      throw new Error(`Failed to resolve brand: ${brandError.message}`);
    }
    const brandId = brandRow?.prompt_sets?.brands?.id;

    if (!brandId) {
      return res.status(400).json({
        error: 'Unable to resolve brand from prompts',
      });
    }

    const results = await analyzeBrandVolumes(brandId, { force });
    const successCount = results.filter((r) => !r.error).length;
    if (successCount > 0 && orgId) {
      await supabaseAdmin.from('volume_usage').insert({
        organization_id: orgId,
        action: 'analyze-batch',
        prompt_count: successCount,
      });
    }

    return res.json({ results, remaining: remaining === -1 ? -1 : remaining - 1 });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return res.status(error.statusCode).json({
        success: false,
        error: 'quota_exceeded',
        message: error.message,
      });
    }
    req.log.error({ err: error }, 'batch volume analysis error');
    return res.status(error.status || 500).json({
      error: 'Failed to analyze prompt volumes',
      details: error.message,
    });
  }
});

/**
 * POST /api/volumes/refresh
 * Refreshes Google volumes for all prompts that already have saved keywords.
 * Does NOT call LLM — only re-fetches DataForSEO volumes.
 * Body: { brandId, locationCode?, languageCode? }
 */
router.post('/refresh', requireFeature('prompt_volumes'), async (req, res) => {
  try {
    const { remaining, orgId } = await enforceVolumeQuota(req.user.id);

    const { brandId, locationCode, languageCode } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }

    await assertBrandAccess(brandId, req.user.id);

    let resolvedLocationCode = locationCode;
    let resolvedLanguageCode = languageCode;
    if (resolvedLocationCode == null || resolvedLanguageCode == null) {
      const { data: brand } = await supabaseAdmin
        .from('brands')
        .select('region, language')
        .eq('id', brandId)
        .maybeSingle();
      if (brand) {
        if (resolvedLocationCode == null) {
          resolvedLocationCode = regionToLocationCode(brand.region);
        }
        if (resolvedLanguageCode == null) {
          resolvedLanguageCode = languageToCode(brand.language);
        }
      }
    }

    const { data: promptSets } = await supabaseAdmin
      .from('prompt_sets')
      .select('id')
      .eq('brand_id', brandId);

    if (!promptSets?.length) {
      return res.json({ results: [], refreshed: 0, remaining });
    }

    const { data: prompts } = await supabaseAdmin
      .from('prompts')
      .select('id')
      .in(
        'prompt_set_id',
        promptSets.map((ps) => ps.id),
      );

    if (!prompts?.length) {
      return res.json({ results: [], refreshed: 0, remaining });
    }

    const { data: existingVolumes } = await supabaseAdmin
      .from('prompt_volumes')
      .select('prompt_id, intent, keywords')
      .in(
        'prompt_id',
        prompts.map((p) => p.id),
      );

    if (!existingVolumes?.length) {
      return res.json({ results: [], refreshed: 0, remaining });
    }

    const results = [];

    for (const row of existingVolumes) {
      try {
        const saved = await fetchAndSaveVolumes(
          row.prompt_id,
          row.keywords,
          row.intent,
          resolvedLocationCode,
          resolvedLanguageCode,
        );
        results.push(mapVolumeRow(saved));
      } catch (err) {
        results.push({ promptId: row.prompt_id, error: err.message });
      }
    }

    const refreshed = results.filter((r) => !r.error).length;
    if (refreshed > 0 && orgId) {
      await supabaseAdmin.from('volume_usage').insert({
        organization_id: orgId,
        action: 'refresh',
        prompt_count: refreshed,
      });
    }

    return res.json({
      results,
      refreshed,
      remaining: remaining === -1 ? -1 : remaining - 1,
    });
  } catch (error) {
    if (error instanceof PlanLimitError) {
      return res.status(error.statusCode).json({
        success: false,
        error: 'quota_exceeded',
        message: error.message,
      });
    }
    req.log.error({ err: error }, 'volume refresh error');
    return res.status(error.status || 500).json({
      error: 'Failed to refresh volumes',
      details: error.message,
    });
  }
});

/**
 * GET /api/volumes/brand/:brandId
 */
router.get('/brand/:brandId', async (req, res) => {
  try {
    const { brandId } = req.params;
    await assertBrandAccess(brandId, req.user.id);

    const { data: promptSets, error: psError } = await supabaseAdmin
      .from('prompt_sets')
      .select('id')
      .eq('brand_id', brandId);

    if (psError) {
      return res.status(500).json({
        error: 'Failed to fetch prompt sets',
        details: psError.message,
      });
    }

    if (!promptSets || promptSets.length === 0) {
      return res.json({ volumes: [] });
    }

    const setIds = promptSets.map((ps) => ps.id);

    const { data: prompts, error: pError } = await supabaseAdmin
      .from('prompts')
      .select('id, text, category, prompt_set_id')
      .in('prompt_set_id', setIds);

    if (pError) {
      return res.status(500).json({ error: 'Failed to fetch prompts', details: pError.message });
    }

    if (!prompts || prompts.length === 0) {
      return res.json({ volumes: [] });
    }

    const promptIds = prompts.map((p) => p.id);

    const { data: volumes, error: vError } = await supabaseAdmin
      .from('prompt_volumes')
      .select('*')
      .in('prompt_id', promptIds)
      .order('est_ai_volume', { ascending: false });

    if (vError) {
      return res.status(500).json({ error: 'Failed to fetch volumes', details: vError.message });
    }

    const promptMap = {};
    for (const p of prompts) {
      promptMap[p.id] = { text: p.text, category: p.category };
    }

    const enriched = (volumes || []).map((v) => ({
      ...mapVolumeRow(v),
      promptText: promptMap[v.prompt_id]?.text || '',
      promptCategory: promptMap[v.prompt_id]?.category || '',
    }));

    const quota = await getVolumeQuotaStatus(req.user.id);

    return res.json({ volumes: enriched, quota });
  } catch (error) {
    req.log.error({ err: error }, 'fetch volumes error');
    return res.status(error.status || 500).json({
      error: 'Failed to fetch volume data',
      details: error.message,
    });
  }
});

export default router;
