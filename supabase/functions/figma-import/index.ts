import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const FIGMA_API = "https://api.figma.com/v1";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}
function getRateLimitDetails(response: Response) {
  const raw = response.headers.get("Retry-After");
  const seconds = raw ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.isFinite(Date.parse(raw)) ? Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000)) : null) : null;
  return {
    retryAfterSeconds: Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null,
    planTier: response.headers.get("X-Figma-Plan-Tier"),
    rateLimitType: response.headers.get("X-Figma-Rate-Limit-Type"),
    upgradeLink: response.headers.get("X-Figma-Upgrade-Link")
  };
}
function cleanNode(node: any): any {
  const keep = [
    "id","name","type","visible","locked","opacity","blendMode","rotation",
    "absoluteBoundingBox","absoluteRenderBounds","relativeTransform","size",
    "children","fills","strokes","strokeWeight","strokeAlign","effects",
    "cornerRadius","rectangleCornerRadii","clipsContent","layoutMode",
    "layoutWrap","primaryAxisSizingMode","counterAxisSizingMode",
    "primaryAxisAlignItems","counterAxisAlignItems","itemSpacing",
    "counterAxisSpacing","paddingLeft","paddingRight","paddingTop","paddingBottom",
    "layoutAlign","layoutGrow","constraints","characters","style","characterStyleOverrides",
    "componentId","componentProperties","exportSettings","arcData","isMask"
  ];
  const out: Record<string, unknown> = {};
  for (const key of keep) {
    if (node[key] !== undefined) out[key] = key === "children" ? (node.children || []).map(cleanNode) : node[key];
  }
  return out;
}
function flatten(nodes: any[], out: any[] = []): any[] {
  for (const node of nodes || []) {
    out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

function describeLayers(root: any, assets: any[] = []) {
  const assetMap = new Map(assets.map(a => [a.nodeId, a.name]));
  const rows: any[] = [];
  const visit = (node: any, parents: string[] = []) => {
    const b = node.absoluteBoundingBox || {}, st = node.style || {};
    const paint = (items: any[] = []) => items.filter(p => p.visible !== false).map(p => p.type === "SOLID" && p.color
      ? "#" + [p.color.r,p.color.g,p.color.b].map((v:number)=>Math.round(v*255).toString(16).padStart(2,"0")).join("").toUpperCase()
      : p.type);
    rows.push({
      id:node.id,name:node.name||"Untitled",type:node.type,parent:parents.at(-1)||null,
      hierarchy:[...parents,node.name||"Untitled"].join(" / "),
      position:{x:b.x??null,y:b.y??null,width:b.width??null,height:b.height??null,rotation:node.rotation??0},
      layout:{mode:node.layoutMode||"NONE",itemGap:node.itemSpacing??null,counterAxisSpacing:node.counterAxisSpacing??null,padding:{top:node.paddingTop??0,right:node.paddingRight??0,bottom:node.paddingBottom??0,left:node.paddingLeft??0},primaryAxisAlign:node.primaryAxisAlignItems||null,counterAxisAlign:node.counterAxisAlignItems||null},
      typography:node.type==="TEXT"?{content:node.characters||"",fontFamily:st.fontFamily||null,fontStyle:st.fontPostScriptName||null,fontWeight:st.fontWeight??null,fontSize:st.fontSize??null,lineHeight:st.lineHeightPx??st.lineHeightPercent??null,letterSpacing:st.letterSpacing??null,textAlign:st.textAlignHorizontal||null}:null,
      appearance:{fills:paint(node.fills||[]),strokes:paint(node.strokes||[]),strokeWeight:node.strokeWeight??null,opacity:node.opacity??1,cornerRadius:node.cornerRadius??null,effects:node.effects||[],blendMode:node.blendMode||null,clipsContent:!!node.clipsContent},
      text:node.characters||null,asset:assetMap.get(node.id)||null
    });
    (node.children||[]).forEach((child:any)=>visit(child,[...parents,node.name||"Untitled"]));
  };
  visit(root); return rows;
}

function safeFileKey(value: unknown) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9]{10,80}$/.test(key)) throw new Error("Invalid Figma file key.");
  return key;
}
function getSupabaseSecret() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    const keys = JSON.parse(raw);
    const key = keys.default || Object.values(keys)[0];
    if (typeof key === "string") return key;
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("Supabase server secret is not configured.");
}
function storageHeaders(key: string, contentType?: string) {
  const headers = new Headers({ apikey: key });
  if (!key.startsWith("sb_secret_")) headers.set("Authorization", `Bearer ${key}`);
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return reply({ message: "Use POST to import a Figma file." }, 405);

  try {
    const authHeader = request.headers.get("Authorization") || "";
    const accessToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!accessToken) return reply({ message: "Please sign in to use FigmaSpecs." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = getSupabaseSecret();
    const publishableRaw = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
    const publishableKeys = publishableRaw ? Object.values(JSON.parse(publishableRaw)) : [];
    const suppliedKey = request.headers.get("apikey") || "";
    if (publishableKeys.length && !publishableKeys.includes(suppliedKey)) return reply({ message: "Supabase client key was not accepted." }, 401);
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: suppliedKey, Authorization: `Bearer ${accessToken}` } });
    if (!authResponse.ok) return reply({ message: "Your session has expired. Please sign in again." }, 401);
    const authUser = await authResponse.json(), userId = authUser.id;
    if (!userId) return reply({ message: "Could not identify your account." }, 401);
    const body = await request.json();
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      if (!response.ok) throw new Error("Secure credential storage request failed.");
      return response.json().catch(() => null);
    };
    if (body.action === "save_token") {
      const candidate = String(body.figmaToken || "").trim(), days = Number(body.retentionDays);
      if (candidate.length < 20 || candidate.length > 500) return reply({ message: "Enter a valid Figma personal access token." }, 400);
      if (![0,1,7,30,90].includes(days)) return reply({ message: "Choose a valid token retention period." }, 400);
      const check = await fetch(`${FIGMA_API}/me`, { headers: { "X-Figma-Token": candidate } });
      if (!check.ok) return reply({ message: "Figma could not validate this token. Check it and try again." }, 400);
      await rpc("figmaspecs_save_token", { p_user_id: userId, p_token: candidate, p_retention_days: days });
      return reply({ saved: true, retentionDays: days });
    }
    if (body.action === "token_status") {
      const status = await rpc("figmaspecs_token_status", { p_user_id: userId }), row = Array.isArray(status) ? status[0] : status;
      if (row?.has_token && row.expires_at && new Date(row.expires_at) <= new Date()) { await rpc("figmaspecs_delete_token", { p_user_id: userId }); return reply({ hasToken: false }); }
      return reply({ hasToken: !!row?.has_token, retentionDays: row?.retention_days || null, expiresAt: row?.expires_at || null });
    }
    if (body.action === "delete_token") { await rpc("figmaspecs_delete_token", { p_user_id: userId }); return reply({ deleted: true }); }
    if (body.action === "github_token_status") {
      const status = await rpc("figmaspecs_github_token_status", { p_user_id: userId }), row = Array.isArray(status) ? status[0] : status;
      if (row?.has_token && row.expires_at && new Date(row.expires_at) <= new Date()) { await rpc("figmaspecs_delete_github_token", { p_user_id: userId }); return reply({ hasToken: false }); }
      return reply({ hasToken: !!row?.has_token, retentionDays: row?.retention_days || null, expiresAt: row?.expires_at || null });
    }
    if (body.action === "save_github_token") {
      const candidate = String(body.githubToken || "").trim(), days = Number(body.retentionDays);
      if (candidate.length < 20 || candidate.length > 500) return reply({ message: "Enter a valid GitHub personal access token." }, 400);
      if (![0,1,7,30,90].includes(days)) return reply({ message: "Choose a valid GitHub token retention period." }, 400);
      const check = await fetch("https://api.github.com/user", { headers: { Authorization: "Bearer " + candidate, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
      if (!check.ok) { const detail = await check.json().catch(() => ({})); return reply({ message: detail.message || "GitHub could not validate this token." }, 400); }
      await rpc("figmaspecs_save_github_token", { p_user_id: userId, p_token: candidate, p_retention_days: days });
      return reply({ saved: true, retentionDays: days, expiresAt: days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString() });
    }
    if (body.action === "get_github_token") {
      const rows = await rpc("figmaspecs_get_github_token", { p_user_id: userId }), row = Array.isArray(rows) ? rows[0] : rows;
      return reply({ token: row?.token || null, retentionDays: row?.retention_days || null, expiresAt: row?.expires_at || null });
    }
    if (body.action === "delete_github_token") {
      await rpc("figmaspecs_delete_github_token", { p_user_id: userId });
      return reply({ deleted: true });
    }
    if (body.action === "refresh_asset_urls") {
      const requested = Array.isArray(body.assets) ? body.assets.slice(0, 1000) : [];
      const refreshed = await Promise.all(requested.map(async (asset: any) => {
        const path = String(asset?.path || "");
        if (!path || !path.startsWith(userId + "/") || path.includes("..")) return { nodeId: asset?.nodeId, error: "Asset path is not available for this account." };
        const encoded = path.split("/").map(encodeURIComponent).join("/");
        const sign = await fetch(`${supabaseUrl}/storage/v1/object/sign/figma-assets/${encoded}`, {
          method: "POST", headers: storageHeaders(serviceKey, "application/json"), body: JSON.stringify({ expiresIn: 3600 })
        });
        const payload = await sign.json().catch(() => ({}));
        if (!sign.ok || !payload.signedURL) return { nodeId: asset?.nodeId, error: "Could not refresh asset URL for " + (asset?.name || path) };
        const url = payload.signedURL.startsWith("http") ? payload.signedURL : supabaseUrl + "/storage/v1" + payload.signedURL;
        return { nodeId: asset?.nodeId, path, name: asset?.name, format: asset?.format, url };
      }));
      return reply({ assets: refreshed });
    }
    const fileKey = safeFileKey(body.fileKey);
    const tokenRows = await rpc("figmaspecs_get_token", { p_user_id: userId });
    const tokenRow = Array.isArray(tokenRows) ? tokenRows[0] : tokenRows;
    const figmaToken = String(tokenRow?.token || "").trim();
    if (!figmaToken) return reply({ message: "Connect your Figma account in settings before importing." }, 400);
    const nodeId = body.nodeId ? String(body.nodeId).replace(/-/g, ":") : "";
    if (!figmaToken || figmaToken.length < 20 || figmaToken.length > 500) {
      return reply({ message: "A valid Figma personal access token is required." }, 400);
    }

    const figmaHeaders = { "X-Figma-Token": figmaToken };
    if (body.action === "export_assets") {
      const requested = Array.isArray(body.assets) ? body.assets.slice(0, 1000) : [];
      if (!requested.length) return reply({ assets: [] });
      const output: any[] = [];
      for (const format of ["png", "svg"]) {
        const group = requested.filter((asset: any) => String(asset?.format).toLowerCase() === format);
        for (let offset = 0; offset < group.length; offset += 20) {
          const batch = group.slice(offset, offset + 20);
          const ids = batch.map((asset: any) => String(asset.nodeId || "").replace(/-/g, ":")).filter(Boolean);
          if (!ids.length) continue;
          const params = new URLSearchParams({ ids: ids.join(","), format, scale: "1" });
          const imageResponse = await fetch(`${FIGMA_API}/images/${fileKey}?${params}`, { headers: figmaHeaders });
          const imagePayload = await imageResponse.json().catch(() => ({}));
          if (imageResponse.status === 429) {
            return reply({ message: "Figma is temporarily rate-limiting asset regeneration. Please try again after the indicated cooldown.", figmaStatus: 429, rateLimit: getRateLimitDetails(imageResponse) }, 429);
          }
          if (!imageResponse.ok) throw new Error("Figma could not regenerate " + format.toUpperCase() + " assets (HTTP " + imageResponse.status + "): " + String(imagePayload.err || imagePayload.message || "Unknown Figma API error"));
          for (const asset of batch) {
            const nodeId = String(asset.nodeId || "").replace(/-/g, ":");
            const sourceUrl = imagePayload.images?.[nodeId];
            if (!sourceUrl) { output.push({ nodeId, name: asset.name, format, error: "Figma did not return an export URL for this asset." }); continue; }
            const download = await fetch(sourceUrl);
            if (!download.ok) { output.push({ nodeId, name: asset.name, format, error: "Could not download the regenerated asset." }); continue; }
            const bytes = await download.arrayBuffer();
            const name = String(asset.name || ("asset-" + nodeId.replace(/:/g, "-") + "." + format)).replace(/[^a-zA-Z0-9._-]/g, "-");
            const path = `${userId}/${fileKey}/${name}`;
            const encoded = path.split("/").map(encodeURIComponent).join("/");
            const uploadHeaders = storageHeaders(serviceKey, format === "svg" ? "image/svg+xml" : "image/png");
            uploadHeaders.set("x-upsert", "true");
            const upload = await fetch(`${supabaseUrl}/storage/v1/object/figma-assets/${encoded}`, { method: "PUT", headers: uploadHeaders, body: bytes });
            if (!upload.ok) { output.push({ nodeId, name, format, error: "Could not store regenerated asset: " + (await upload.text()).slice(0, 120) }); continue; }
            const sign = await fetch(`${supabaseUrl}/storage/v1/object/sign/figma-assets/${encoded}`, { method: "POST", headers: storageHeaders(serviceKey, "application/json"), body: JSON.stringify({ expiresIn: 3600 }) });
            const signed = await sign.json().catch(() => ({}));
            if (!sign.ok || !signed.signedURL) { output.push({ nodeId, name, format, error: "Could not create a fresh asset download URL." }); continue; }
            const url = signed.signedURL.startsWith("http") ? signed.signedURL : supabaseUrl + "/storage/v1" + signed.signedURL;
            output.push({ nodeId, name, format, path, url, stored: true });
          }
        }
      }
      return reply({ assets: output });
    }
    const endpoint = nodeId
      ? `${FIGMA_API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
      : `${FIGMA_API}/files/${fileKey}?geometry=paths`;
    const fileResponse = await fetch(endpoint, { headers: figmaHeaders });
    const filePayload = await fileResponse.json().catch(() => ({}));
    if (!fileResponse.ok) {
      const message = fileResponse.status === 403
        ? "Figma denied access. Check your token's file content read permission and access to this file."
        : fileResponse.status === 404
          ? "Figma file or selected node was not found. Check the URL and file permissions."
          : fileResponse.status === 429
            ? "Figma rate limit reached. Wait a little and try again."
            : String(filePayload.err || filePayload.message || "Figma could not return this design.");
      return reply({ message, figmaStatus: fileResponse.status, ...(fileResponse.status === 429 ? { rateLimit: getRateLimitDetails(fileResponse) } : {}) }, fileResponse.status === 429 ? 429 : 400);
    }

    const fileName = filePayload.name || "Figma design";
    const lastModified = filePayload.lastModified || null;
    let document: any;
    if (nodeId) {
      const selectedNode = filePayload.nodes?.[nodeId];
      if (!selectedNode?.document) return reply({ message: "The selected Figma frame could not be found." }, 404);
      document = selectedNode.document;
    } else {
      document = filePayload.document;
    }
    if (!document) return reply({ message: "Figma returned an empty document." }, 422);

    const nodes = flatten([document]);
    // A Figma layer is exportable when it has an image fill, is a vector/shape,
    // or has explicit export settings (which also covers frames, groups,
    // components, instances, slices and other supported node types).
    const vectorTypes = new Set(["VECTOR","BOOLEAN_OPERATION","RECTANGLE","ELLIPSE","STAR","POLYGON","LINE","REGULAR_POLYGON","SHAPE_WITH_TEXT"]);
    const candidates = nodes
      .filter((node: any) => node?.id)
      .map((node: any) => {
        const hasImageFill = (node.fills || []).some((fill: any) => fill.type === "IMAGE" && fill.visible !== false);
        const settings = (node.exportSettings || []).filter((setting: any) => ["PNG","JPG","SVG"].includes(String(setting.format || "").toUpperCase()));
        if (settings.length) {
          const selectedFormat = String(settings[0].format).toLowerCase();
          return { node, format: selectedFormat === "svg" ? "svg" : "png" };
        }
        if (hasImageFill) return { node, format: "png" };
        if (vectorTypes.has(node.type)) return { node, format: "svg" };
        return null;
      })
      .filter(Boolean) as Array<{node:any;format:"png"|"svg"}>;
    const candidateById = new Map<string, {node:any;format:"png"|"svg"}>();
    for (const candidate of candidates) candidateById.set(candidate.node.id, candidate);
    const exportCandidates = [...candidateById.values()];
    const imageNodeIds = exportCandidates.filter(item => item.format === "png").map(item => item.node.id);
    const vectorNodeIds = exportCandidates.filter(item => item.format === "svg").map(item => item.node.id);
    const assetIds = exportCandidates.map(item => item.node.id);
    const includeAssets = body.includeAssets !== false;
    const imageMap: Record<string, string> = {};
    const assetWarnings: string[] = [];
    let assetRateLimited = false;
    if (includeAssets) {
      for (const format of ["png", "svg"] as const) {
        if (assetRateLimited) break;
        const ids = exportCandidates.filter(item => item.format === format).map(item => item.node.id);
        // Keep render requests deliberately small to reduce burst pressure on Figma.
        for (let offset = 0; offset < ids.length; offset += 20) {
          const batchIds = ids.slice(offset, offset + 20);
          if (!batchIds.length) continue;
          const params = new URLSearchParams({ ids: batchIds.join(","), format, scale: "1" });
          const response = await fetch(`${FIGMA_API}/images/${fileKey}?${params}`, { headers: figmaHeaders });
          const payload = await response.json().catch(() => ({}));
          if (response.status === 429) {
            assetWarnings.push("Figma temporarily rate-limited asset rendering. The design data was imported, but some images and vectors were skipped. Avoid repeated imports; try the asset export again later.");
            assetRateLimited = true;
            var assetRateLimit = getRateLimitDetails(response);
            break;
          }
          if (!response.ok) {
            assetWarnings.push(`Figma could not render ${format.toUpperCase()} assets (HTTP ${response.status}). The design was imported, but these assets were skipped.`);
            continue;
          }
          Object.assign(imageMap, payload.images || {});
        }
      }
  
      }

    const renderAssets = assetIds.map(id => {
      const candidate = candidateById.get(id);
      const node = candidate?.node;
      const url = imageMap[id];
      if (!url) return null;
      const format = candidate!.format;
      const safeName = String(node?.name || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      return { nodeId: id, name: `${safeName || "asset"}-${id.replace(/:/g, "-")}.${format}`, format, sourceUrl: url };
    }).filter(Boolean);

    if (!supabaseUrl) throw new Error("SUPABASE_URL is not configured.");
    const storedAssets: any[] = [];
    for (let i = 0; i < renderAssets.length; i += 6) {
      const batch = renderAssets.slice(i, i + 6);
      const results = await Promise.all(batch.map(async (asset: any) => {
        try {
          const download = await fetch(asset.sourceUrl);
          if (!download.ok) throw new Error("Figma asset download failed.");
          const bytes = await download.arrayBuffer();
          const mime = asset.format === "svg" ? "image/svg+xml" : "image/png";
          const path = `${userId}/${fileKey}/${asset.name}`;
          const encoded = path.split("/").map(encodeURIComponent).join("/");
          const upload = await fetch(`${supabaseUrl}/storage/v1/object/figma-assets/${encoded}`, {
            method: "POST",
            headers: storageHeaders(serviceKey, mime),
            body: bytes
          });
          if (!upload.ok) throw new Error("Storage upload failed: " + (await upload.text()).slice(0, 150));
          const sign = await fetch(`${supabaseUrl}/storage/v1/object/sign/figma-assets/${encoded}`, {
            method: "POST",
            headers: storageHeaders(serviceKey, "application/json"),
            body: JSON.stringify({ expiresIn: 604800 })
          });
          const signed = await sign.json().catch(() => ({}));
          if (!sign.ok || !signed.signedURL) throw new Error("Could not create signed asset URL.");
          const signedUrl = signed.signedURL.startsWith("http") ? signed.signedURL : supabaseUrl + "/storage/v1" + signed.signedURL;
          return { nodeId: asset.nodeId, name: asset.name, format: asset.format, path, url: signedUrl, stored: true };
        } catch (error) {
          console.error("Asset persistence failed", asset.nodeId, error instanceof Error ? error.message : error);
          return { nodeId: asset.nodeId, name: asset.name, format: asset.format, url: asset.sourceUrl, stored: false };
        }
      }));
      storedAssets.push(...results);
    }

    const stats = {
      layers: nodes.length,
      text: nodes.filter(n => n.type === "TEXT").length,
      images: imageNodeIds.length,
      vectors: vectorNodeIds.length
    };
    return reply({
      importId: null,
      name: fileName,
      lastModified,
      version: filePayload.version || null,
      document: cleanNode(document),
      assets: storedAssets,
      assetCandidates: exportCandidates.map(({node,format}) => ({
        nodeId: node.id,
        name: String(node.name || "asset").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) + "-" + node.id.replace(/:/g, "-") + "." + format,
        format
      })),
      assetsIncluded: includeAssets,
      assetWarnings,
      ...(typeof assetRateLimit !== "undefined" ? { rateLimit: assetRateLimit } : {}),
      stats
    });
  } catch (error) {
    console.error("figma-import error", error instanceof Error ? error.message : error);
    return reply({ message: error instanceof Error ? error.message : "Unexpected import error." }, 500);
  }
});