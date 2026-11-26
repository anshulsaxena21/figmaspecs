import React, { useEffect, useMemo, useState } from "react";
import { supabase, SUPABASE_PUBLISHABLE_KEY } from "../lib/supabase";
import { Activity, ArrowDownToLine, ArrowRight, Box, Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleHelp, Code2, Copy, FileImage, FileJson, Figma, Frame, Github, Image as ImageIcon, Layers3, Link2, LoaderCircle, LockKeyhole, Palette, Ruler, Search, Settings2, Sparkles, Type, X } from "lucide-react";

const PROJECT_URL = "https://ovdxipfxychotaspfccl.supabase.co";
const FUNCTION_URL = PROJECT_URL + "/functions/v1/figma-import";


let PROJECT_DB_NAME = "figmaspecs-guest";
const PROJECT_STORE = "saved-projects";
function openProjectDB() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("This browser does not support IndexedDB."));
    const request = indexedDB.open(PROJECT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local project storage."));
    request.onblocked = () => reject(new Error("Project storage is blocked by another browser tab. Close duplicate importer tabs and retry."));
  });
}
async function putSavedProject(project) {
  const db = await openProjectDB();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readwrite");
    tx.objectStore(PROJECT_STORE).put(project);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Could not save the project."));
    tx.onabort = () => reject(tx.error || new Error("Project save was cancelled."));
  }); } finally { db.close(); }
}
async function getSavedProjects() {
  const db = await openProjectDB();
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).getAll();
    request.onsuccess = () => resolve((request.result || []).sort((a,b) => new Date(b.savedAt)-new Date(a.savedAt)));
    request.onerror = () => reject(request.error || new Error("Could not read saved projects."));
  }); } finally { db.close(); }
}
async function deleteSavedProject(id) {
  const db = await openProjectDB();
  try { await new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECT_STORE, "readwrite");
    tx.objectStore(PROJECT_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("Could not delete saved project."));
  }); } finally { db.close(); }
}
function safeFileName(value, fallback = "asset") {
  const name = String(value || fallback).split(/[\\\\/]/).pop().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return name || fallback;
}

function parseFigmaUrl(value) {
  const url = new URL(value.trim());
  if (!/^(www\.)?figma\.com$/.test(url.hostname)) throw new Error("Paste a valid figma.com design or file URL.");
  const parts = url.pathname.split("/").filter(Boolean);
  const keyIndex = parts.findIndex((part) => part === "design" || part === "file");
  if (keyIndex < 0 || !parts[keyIndex + 1]) throw new Error("This link should point to a Figma design or file.");
  const fileKey = parts[keyIndex + 1];
  const nodeId = url.searchParams.get("node-id")?.replace(/-/g, ":") || null;
  return { fileKey, nodeId };
}

function walk(nodes, output = []) {
  for (const node of nodes || []) {
    output.push(node);
    if (node.children) walk(node.children, output);
  }
  return output;
}

function px(value) { return typeof value === "number" ? Math.round(value * 100) / 100 + "px" : "—"; }
function rgba(color, opacity = 1) {
  if (!color) return "—";
  const hex = [color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  return "#" + hex.toUpperCase() + (opacity < 1 ? " / " + Math.round(opacity * 100) + "%" : "");
}
function downloadText(name, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.style.display = "none"; document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function cssTokens(nodes) {
  const colors = new Map(); const fonts = new Map(); const radii = new Set(); const spaces = new Set();
  nodes.forEach((n) => {
    (n.fills || []).filter((f) => f.type === "SOLID" && f.visible !== false).forEach((f) => colors.set(rgba(f.color, f.opacity ?? 1), true));
    if (n.style?.fontFamily) fonts.set(n.style.fontFamily, true);
    if (n.cornerRadius) radii.add(n.cornerRadius);
    [n.itemSpacing, n.paddingLeft, n.paddingRight, n.paddingTop, n.paddingBottom].forEach((v) => { if (typeof v === "number" && v > 0) spaces.add(v); });
  });
  let css = ":root {\n";
  [...colors.keys()].forEach((c, i) => css += `  --figma-color-${i + 1}: ${c};\n`);
  [...fonts.keys()].forEach((f, i) => css += `  --figma-font-${i + 1}: "${f}", sans-serif;\n`);
  [...[...radii].sort((a,b)=>a-b)].forEach((v,i) => css += `  --figma-radius-${i + 1}: ${v}px;\n`);
  [...[...spaces].sort((a,b)=>a-b)].forEach((v,i) => css += `  --figma-space-${i + 1}: ${v}px;\n`);
  return css + "}\n";
}


function describeLayers(root, assets = []) {
  const assetMap = new Map(assets.map(a => [a.nodeId, a.name]));
  const rows = [];
  const visit = (node, parents = []) => {
    const b = node.absoluteBoundingBox || {}, st = node.style || {};
    const paints = (node.fills || []).filter(p => p.visible !== false).map(p => p.type === "SOLID" ? rgba(p.color, p.opacity ?? 1) : p.type);
    const strokes = (node.strokes || []).filter(p => p.visible !== false).map(p => p.type === "SOLID" ? rgba(p.color, p.opacity ?? 1) : p.type);
    rows.push({ id:node.id, name:node.name||"Untitled", type:node.type, parent:parents.at(-1)||null,
      hierarchy:[...parents,node.name||"Untitled"].join(" / "),
      position:{x:b.x??null,y:b.y??null,width:b.width??null,height:b.height??null,rotation:node.rotation??0},
      layout:{mode:node.layoutMode||"NONE",itemGap:node.itemSpacing??null,counterAxisSpacing:node.counterAxisSpacing??null,padding:{top:node.paddingTop??0,right:node.paddingRight??0,bottom:node.paddingBottom??0,left:node.paddingLeft??0},primaryAxisAlign:node.primaryAxisAlignItems||null,counterAxisAlign:node.counterAxisAlignItems||null},
      typography:node.type==="TEXT"?{content:node.characters||"",fontFamily:st.fontFamily||null,fontStyle:st.fontPostScriptName||null,fontWeight:st.fontWeight??null,fontSize:st.fontSize??null,lineHeight:st.lineHeightPx??st.lineHeightPercent??null,letterSpacing:st.letterSpacing??null,textAlign:st.textAlignHorizontal||null}:null,
      appearance:{fills:paints,strokes,strokeWeight:node.strokeWeight??null,opacity:node.opacity??1,cornerRadius:node.cornerRadius??null,effects:node.effects||[],blendMode:node.blendMode||null,clipsContent:!!node.clipsContent},
      text:node.characters||null,asset:assetMap.get(node.id)||null });
    (node.children||[]).forEach(child=>visit(child,[...parents,node.name||"Untitled"]));
  };
  visit(root); return rows;
}
function csvEscape(v){const x=v==null?"":typeof v==="object"?JSON.stringify(v):String(v);return '"'+x.replace(/"/g,'""')+'"';}
function crc32(bytes){let c=-1;for(let i=0;i<bytes.length;i++){c^=bytes[i];for(let j=0;j<8;j++)c=(c>>>1)^(0xEDB88320&-(c&1));}return(c^-1)>>>0;}
function zipBlob(files){
  const enc=new TextEncoder(),local=[],central=[];let offset=0;
  const u16=v=>[v&255,(v>>>8)&255],u32=v=>[...u16(v&65535),...u16(v>>>16)];
  for(const file of files){const name=enc.encode(file.name),data=file.data instanceof Uint8Array?file.data:enc.encode(String(file.data)),crc=crc32(data);
    const h=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0),...name]);
    local.push(h,data);
    central.push(new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(data.length),...u32(data.length),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...name]));
    offset+=h.length+data.length;
  }
  const size=central.reduce((n,a)=>n+a.length,0),end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(files.length),...u16(files.length),...u32(size),...u32(offset),...u16(0)]);
  return new Blob([...local,...central,end],{type:"application/zip"});
}
function saveBlob(name,blob){const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}

export default function FigmaImporter({ session, onSignOut }) {
  const [themePanelOpen, setThemePanelOpen] = useState(false);
  const [accentDraft, setAccentDraft] = useState(() => {
    try { return JSON.parse(localStorage.getItem("figmaspecs-theme-" + session.user.id))?.accent || "#ff6600"; } catch { return "#ff6600"; }
  });
  const [themeMode, setThemeMode] = useState(() => {
    try { return JSON.parse(localStorage.getItem("figmaspecs-theme-" + session.user.id))?.mode || "light"; } catch { return "light"; }
  });
  const [accentColor, setAccentColor] = useState(accentDraft);
  const [savedThemeNotice, setSavedThemeNotice] = useState(false);
  const isValidHex = value => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
  const normalizeHex = value => {
    const hex = value.trim();
    if (!isValidHex(hex)) return null;
    return hex.length === 4 ? "#" + [...hex.slice(1)].map(char => char + char).join("") : hex;
  };
  const applyTheme = () => {
    const normalized = normalizeHex(accentDraft);
    if (!normalized) return;
    setAccentColor(normalized);
    try { localStorage.setItem("figmaspecs-theme-" + session.user.id, JSON.stringify({ accent: normalized, mode: themeMode })); } catch {}
    setSavedThemeNotice(true);
    window.setTimeout(() => setSavedThemeNotice(false), 2200);
  };
  const resetTheme = () => {
    setAccentDraft("#ff6600"); setAccentColor("#ff6600"); setThemeMode("light");
    try { localStorage.removeItem("figmaspecs-theme-" + session.user.id); } catch {}
  };
  const [figmaUrl, setFigmaUrl] = useState("");
  const [token, setToken] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [tokenStatus, setTokenStatus] = useState({ hasToken: false, expiresAt: null, retentionDays: null });
  const [tokenSaving, setTokenSaving] = useState(false);
  const [githubUploadOpen, setGithubUploadOpen] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [githubRetentionDays, setGithubRetentionDays] = useState(30);
  const [githubTokenStatus, setGithubTokenStatus] = useState({ hasToken: false, retentionDays: null, expiresAt: null });
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("");
  const [githubPath, setGithubPath] = useState("figmaspecs-exports");
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubUsername, setGithubUsername] = useState("");
  const [githubRepos, setGithubRepos] = useState([]);
  const [githubRepoLoading, setGithubRepoLoading] = useState(false);
  const [githubProgress, setGithubProgress] = useState({ active: false, stage: "", current: 0, total: 0, percent: 0, fileName: "" });
  const [githubToast, setGithubToast] = useState(null);
  const [showFigmaTokenHelp, setShowFigmaTokenHelp] = useState(false);
  const [showGithubTokenHelp, setShowGithubTokenHelp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [design, setDesign] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("layers");
  const [expanded, setExpanded] = useState({});
  const [copied, setCopied] = useState(false);
  const [savedProjects, setSavedProjects] = useState([]);
  const [saveStatus, setSaveStatus] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [showAiHandoff, setShowAiHandoff] = useState(false);
  const [showMoreExports, setShowMoreExports] = useState(false);
  const [frameScreenshotRetryBlocked, setFrameScreenshotRetryBlocked] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [referenceImage, setReferenceImage] = useState("");
  const [implementationImage, setImplementationImage] = useState("");
  const [comparisonOpacity, setComparisonOpacity] = useState(50);
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(false);
  const [promptFramework, setPromptFramework] = useState("Detect from repository");
  const [promptStyling, setPromptStyling] = useState("Use the existing styling approach");
  const [promptViewport, setPromptViewport] = useState("Desktop, tablet and mobile");
  const [promptExtra, setPromptExtra] = useState("");
  const [generatedPrompt, setGeneratedPrompt] = useState("");

  const [figmaRateLimitBlocked, setFigmaRateLimitBlocked] = useState(false);
  useEffect(() => {
    let alive = true;
    PROJECT_DB_NAME = "figmaspecs-" + session.user.id;
    (async () => {
      try {
        const { data, error: dbError } = await supabase.from("figma_user_projects").select("id,name,design_data,assets,stats,created_at,updated_at").order("updated_at", { ascending: false });
        if (dbError) throw dbError;
        const projects = (data || []).map(row => ({ id: row.id, name: row.name, savedAt: row.updated_at || row.created_at, design: { name: row.name, document: row.design_data, assets: row.assets || [], stats: row.stats || {}, fileKey: row.stats?.fileKey || null } }));
        if (alive) setSavedProjects(projects);
      } catch (err) { if (alive) setError("Could not load your cloud projects: " + err.message); }
      finally { if (alive) setStorageReady(true); }
    })();
    callFigmaFunction({ action: "token_status" }).then(status => {
      if (alive) { setTokenStatus(status); if (status.retentionDays) setRetentionDays(status.retentionDays); }
    }).catch(err => { if (alive) setError("Could not check Figma connection: " + err.message); });
    callFigmaFunction({ action: "github_token_status" }).then(async status => {
      if (!alive) return;
      setGithubTokenStatus(status);
      if (status.retentionDays !== null && status.retentionDays !== undefined) setGithubRetentionDays(status.retentionDays);
      if (status.hasToken) {
        const saved = await callFigmaFunction({ action: "get_github_token" });
        if (!alive || !saved.token) return;
        setGithubToken(saved.token);
        await connectGithub(saved.token, false);
      }
    }).catch(err => { if (alive) setGithubToast({ type: "error", title: "GitHub reconnect failed", message: err.message }); });
    return () => { alive = false; };
  }, [session.user.id]);

  async function callFigmaFunction(body) {
    const { data: { session: activeSession } } = await supabase.auth.getSession();
    if (!activeSession?.access_token) throw new Error("Your session expired. Please sign in again.");
    const response = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: "Bearer " + activeSession.access_token },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "FigmaSpecs request failed.");
    return payload;
  }

  async function saveFigmaToken() {
    setTokenSaving(true); setError("");
    try {
      const result = await callFigmaFunction({ action: "save_token", figmaToken: token, retentionDays });
      setToken(""); setTokenStatus({ hasToken: true, retentionDays, expiresAt: result.expiresAt || null });
      setSaveStatus("Figma token connected securely."); setShowSettings(false);
    } catch (err) { setError(err.message); }
    finally { setTokenSaving(false); }
  }
  async function removeFigmaToken() {
    try { await callFigmaFunction({ action: "delete_token" }); setTokenStatus({ hasToken: false }); setSaveStatus("Figma token removed."); }
    catch (err) { setError(err.message); }
  }

  const allNodes = useMemo(() => design ? walk([design.document]) : [], [design]);
  const selectedNode = selected ? allNodes.find((n) => n.id === selected) : null;
  const filteredNodes = useMemo(() => allNodes.filter((n) => (n.name || "").toLowerCase().includes(query.toLowerCase()) || (n.type || "").toLowerCase().includes(query.toLowerCase())), [allNodes, query]);
  const counts = useMemo(() => ({
    layers: allNodes.length,
    text: allNodes.filter(n => n.type === "TEXT").length,
    images: allNodes.filter(n => (n.fills || []).some(f => f.type === "IMAGE")).length,
    vectors: allNodes.filter(n => ["VECTOR","BOOLEAN_OPERATION"].includes(n.type)).length
  }), [allNodes]);

  async function importDesign(e) {
    e?.preventDefault(); setError(""); setImporting(true); setDesign(null); setSelected(null);
    try {
      if (!tokenStatus.hasToken) { setShowSettings(true); throw new Error("Connect your Figma personal access token in Connection settings first."); }
      const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
      const payload = await callFigmaFunction({ fileKey, nodeId });
      setDesign({ ...payload, fileKey, frameName: nodeId ? (payload.document?.name || "Selected frame") : "All frames" });
      const root = payload.document?.children?.[0] || payload.document;
      if (root?.id) setSelected(root.id);
      setExpanded({ [payload.document?.id]: true, [root?.id]: true });
    } catch (err) { setError(err.message || "Something went wrong while importing the design."); }
    finally { setImporting(false); }
  }

  function exportAssets() {
    const assets = design?.assets || [];
    if (!assets.length) { setError("No exportable image or vector assets were found in this frame."); return; }
    assets.forEach((asset, i) => {
      const a = document.createElement("a"); a.href = asset.url; a.target = "_blank"; a.rel = "noreferrer"; a.download = asset.name || `figma-asset-${i + 1}`; a.click();
    });
  }
  async function copyText(value) {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { setError("Clipboard access was blocked by the browser."); }
  }
  function exportJson() { downloadText("figma-design.json", JSON.stringify(design, null, 2), "application/json"); }
  function exportTokens() { downloadText("figma-tokens.css", cssTokens(allNodes), "text/css"); }
  async function getFreshExportAssets(allowPartial = false) {
    // Export is deliberately Figma-API-free. Reuse the assets captured at
    // import time; refresh only their Supabase Storage signed URLs.
    const assets = design?.assets || [];
    if (!assets.length) return [];
    const resolved = new Map();
    const storedAssets = assets.filter(asset => asset.path && asset.stored !== false);
    if (storedAssets.length) {
      try {
        const storageResult = await callFigmaFunction({
          action: "refresh_asset_urls",
          assets: storedAssets.map(({nodeId,name,format,path})=>({nodeId,name,format,path}))
        });
        for (const asset of storageResult.assets || []) {
          if (asset.url && !asset.error) resolved.set(asset.nodeId, asset);
        }
      } catch (error) {
        // Keep still-valid URLs from the original import if storage refresh is
        // temporarily unavailable. Never fall back to the Figma API here.
      }
    }
    const ordered = assets.map(asset => {
      const refreshed = resolved.get(asset.nodeId);
      const usableUrl = refreshed?.url || asset.url || null;
      return {...asset, ...(refreshed || {}), url: usableUrl, stored: !!asset.path, unavailable: !usableUrl};
    });
    const unresolved = ordered.filter(asset => !asset.url);
    if (unresolved.length && !allowPartial) {
      throw new Error(unresolved.length + " saved asset(s) are unavailable. No Figma API request was made. Re-import only if you explicitly want to recover missing assets.");
    }
    setDesign(current => current ? ({...current, assets:ordered}) : current);
    return ordered;
  }

  async function getFrameScreenshots() {
    const nodes = walk([design?.document]).filter(node => node?.type === "FRAME" && node.id);
    const unique = [...new Map(nodes.map(node => [node.id, node])).values()].slice(0, 100);
    if (!unique.length) return [];
    const previous = design?.frameScreenshots || [];
    const resolved = new Map();

    const stored = previous.filter(item => item.path && item.stored !== false);
    if (stored.length) {
      const refreshed = await callFigmaFunction({
        action: "refresh_asset_urls",
        assets: stored.map(({nodeId,name,format,path}) => ({nodeId,name,format,path}))
      });
      for (const item of refreshed.assets || []) if (item.url && !item.error) resolved.set(item.nodeId, item);
    }

    const missing = unique.filter(node => !resolved.has(node.id));
    if (missing.length) {
      const fileKey = design?.fileKey || (figmaUrl ? parseFigmaUrl(figmaUrl).fileKey : null);
      if (!fileKey) throw new Error("Frame screenshots need the original Figma file key.");
      const result = await callFigmaFunction({
        action: "export_assets",
        fileKey,
        assets: missing.map(node => ({
          nodeId: node.id,
          name: "frame-" + String(node.name || "untitled").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,50) + "-" + node.id.replace(/:/g,"-") + ".png",
          format: "png"
        }))
      });
      for (const item of result.assets || []) if (item.url && !item.error) resolved.set(item.nodeId, item);
    }
    const failed = unique.filter(node => !resolved.has(node.id));
    const screenshots = unique.filter(node => resolved.has(node.id)).map(node => ({
      ...resolved.get(node.id),
      nodeId: node.id,
      name: resolved.get(node.id).name,
      frameName: node.name,
      width: node.absoluteBoundingBox?.width || node.size?.x || null,
      height: node.absoluteBoundingBox?.height || node.size?.y || null,
      stored: true
    }));
    // Keep successful screenshots even when one frame cannot be rendered.
    setDesign(current => current ? ({...current, frameScreenshots: screenshots}) : current);
    return Object.assign(screenshots, { failedFrames: failed.map(node => node.name || node.id) });
  }

  async function exportReact() {
    if (!design?.document) { setError("Import a Figma design before exporting React."); return; }
    setLoading(true); setError("");
    try {
      const assets = await getFreshExportAssets(false);
      const assetPaths = new Map();
      assets.forEach((asset,index) => {
        const filename = (index+1) + "-" + safeFileName(asset.name, "asset" + (asset.format === "svg" ? ".svg" : ".png"));
        assetPaths.set(asset.nodeId, "../" + (asset.format === "svg" ? "assets/vectors/" : "assets/images/") + filename);
      });
      const className = node => "figma-" + String(node.id || "layer").replace(/[^a-zA-Z0-9_-]/g, "-");
      const cssColor = paint => paint?.type === "SOLID" && paint.color
        ? "rgba(" + Math.round(paint.color.r*255) + ", " + Math.round(paint.color.g*255) + ", " + Math.round(paint.color.b*255) + ", " + (paint.opacity ?? 1) + ")"
        : null;
      const emit = (node,depth=2) => {
        const isText=node.type==="TEXT",tag=isText?"p":"div";
        const escapeText=value=>String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\{/g,"&#123;").replace(/\}/g,"&#125;");
        const content=isText?escapeText(node.characters):(node.children||[]).map(child=>emit(child,depth+1)).join("\n");
        const pad="  ".repeat(depth);
        return pad+"<"+tag+' className="'+className(node)+'">'+(content?"\n"+content+"\n"+pad:"")+"</"+tag+">";
      };
      const css=[];
      const rules=(node,parent=null)=>{
        const box=node.absoluteBoundingBox||{},pbox=parent?.absoluteBoundingBox||{};
        const fills=(node.fills||[]).filter(p=>p.visible!==false),solid=fills.find(p=>p.type==="SOLID"),image=fills.find(p=>p.type==="IMAGE");
        const assetPath=assetPaths.get(node.id),style=node.style||{},lines=["."+className(node)+" {"];
        if(!parent) lines.push("  position: relative;","  width: 100%;","  min-height: 100vh;");
        else if(parent.layoutMode==="HORIZONTAL"||parent.layoutMode==="VERTICAL"){
          lines.push("  position: relative;","  flex: "+(node.layoutGrow?"1 1 0":"0 0 auto")+";");
          if(box.width!=null)lines.push("  width: "+box.width+"px;");
          if(box.height!=null)lines.push("  min-height: "+box.height+"px;");
        } else {
          lines.push("  position: absolute;");
          if(box.x!=null&&pbox.x!=null)lines.push("  left: "+(box.x-pbox.x)+"px;");
          if(box.y!=null&&pbox.y!=null)lines.push("  top: "+(box.y-pbox.y)+"px;");
          if(box.width!=null)lines.push("  width: "+box.width+"px;");
          if(box.height!=null)lines.push("  height: "+box.height+"px;");
        }
        if(node.layoutMode==="HORIZONTAL"||node.layoutMode==="VERTICAL"){
          lines.push("  display: flex;","  flex-direction: "+(node.layoutMode==="HORIZONTAL"?"row":"column")+";");
          if(node.itemSpacing!=null)lines.push("  gap: "+node.itemSpacing+"px;");
          lines.push("  padding: "+[node.paddingTop||0,node.paddingRight||0,node.paddingBottom||0,node.paddingLeft||0].map(v=>v+"px").join(" ")+";");
          const justify={MIN:"flex-start",CENTER:"center",MAX:"flex-end",SPACE_BETWEEN:"space-between"},align={MIN:"flex-start",CENTER:"center",MAX:"flex-end",BASELINE:"baseline"};
          if(node.primaryAxisAlignItems)lines.push("  justify-content: "+(justify[node.primaryAxisAlignItems]||"flex-start")+";");
          if(node.counterAxisAlignItems)lines.push("  align-items: "+(align[node.counterAxisAlignItems]||"stretch")+";");
        }
        if(solid)lines.push("  background-color: "+cssColor(solid)+";");
        if(image&&assetPath)lines.push('  background-image: url("'+assetPath+'");',"  background-size: cover;","  background-position: center;");
        if(node.cornerRadius)lines.push("  border-radius: "+node.cornerRadius+"px;");
        if(node.opacity!=null&&node.opacity!==1)lines.push("  opacity: "+node.opacity+";");
        if(node.strokeWeight){const stroke=(node.strokes||[]).find(p=>p.type==="SOLID"&&p.visible!==false);if(stroke)lines.push("  border: "+node.strokeWeight+"px solid "+cssColor(stroke)+";");}
        if(node.type==="TEXT"){
          if(style.fontFamily)lines.push('  font-family: "'+String(style.fontFamily).replace(/"/g,"")+'", sans-serif;');
          if(style.fontSize)lines.push("  font-size: "+style.fontSize+"px;");
          if(style.fontWeight)lines.push("  font-weight: "+style.fontWeight+";");
          if(style.lineHeightPx)lines.push("  line-height: "+style.lineHeightPx+"px;");
          if(style.letterSpacing)lines.push("  letter-spacing: "+style.letterSpacing+"px;");
          if(style.textAlignHorizontal)lines.push("  text-align: "+style.textAlignHorizontal.toLowerCase()+";");
          const textFill=fills.find(p=>p.type==="SOLID");if(textFill)lines.push("  color: "+cssColor(textFill)+";");
          lines.push("  margin: 0;","  white-space: pre-wrap;");
        }
        lines.push("}");css.push(lines.join("\n"));(node.children||[]).forEach(child=>rules(child,node));
      };
      rules(design.document);
      const jsx='import React from "react";\nimport "./FigmaExport.css";\n\nexport default function FigmaExport() {\n  return (\n    <main className="'+className(design.document)+'">\n'+(design.document.children||[]).map(child=>emit(child,3)).join("\n")+'\n    </main>\n  );\n}\n';
      const files=[
        {name:"code/FigmaExport.jsx",data:jsx},
        {name:"code/FigmaExport.css",data:css.join("\n\n")+"\n"},
        {name:"README.md",data:"# React + CSS export\n\nCopy the code and assets folders into your React app. FigmaExport.jsx imports FigmaExport.css. Image fills use relative paths under assets. React must be installed in the target project.\n"}
      ];
      for(let i=0;i<assets.length;i++){
        const asset=assets[i];
        if(!asset.url) throw new Error("Missing URL for image/vector "+asset.name);
        const response=await fetch(asset.url);
        if(!response.ok) throw new Error("Could not download "+asset.name+" (HTTP "+response.status+").");
        const bytes=new Uint8Array(await response.arrayBuffer());
        files.push({name:(asset.format==="svg"?"assets/vectors/":"assets/images/")+String(i+1).padStart(3,"0")+"-"+safeFileName(asset.name,"asset"+(asset.format==="svg"?".svg":".png")),data:bytes});
      }
      files.push({name:"assets/asset-manifest.json",data:JSON.stringify(assets,null,2)});
      const projectName=safeFileName(design.name,"figma-project").replace(/\.[^.]+$/,"");
      saveBlob(projectName+"-react-css.zip",zipBlob(files));
      setSaveStatus("React + CSS bundle downloaded");
    } catch(err){setError("React + CSS export failed: "+(err.message||"Unknown error"));}
    finally{setLoading(false);}
  }

  function exportAssetsManifest() { downloadText("figma-assets.json", JSON.stringify(design.assets || [], null, 2), "application/json"); }


  async function saveCurrentProject() {
    if (!design?.document) { setError("Import a Figma design before saving."); return; }
    setSaveStatus("Saving to your account…"); setError("");
    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) throw new Error("Please sign in again.");
      const row = { user_id: userData.user.id, name: design.name || "Untitled Figma project", design_data: design.document, assets: design.assets || [], stats: { ...(design.stats || {}), fileKey: design.fileKey || parseFigmaUrl(figmaUrl).fileKey, frameName: design.frameName || "All frames" }, updated_at: new Date().toISOString() };
      const { error: saveError } = await supabase.from("figma_user_projects").insert(row);
      if (saveError) throw saveError;
      const { data, error: listError } = await supabase.from("figma_user_projects").select("id,name,design_data,assets,stats,created_at,updated_at").order("updated_at", { ascending: false });
      if (listError) throw listError;
      setSavedProjects((data || []).map(item => ({ id: item.id, name: item.name, savedAt: item.updated_at || item.created_at, design: { name: item.name, frameName: item.stats?.frameName || "All frames", document: item.design_data, assets: item.assets || [], stats: item.stats || {}, fileKey: item.stats?.fileKey || null } })));
      setSaveStatus("Saved securely to your account.");
    } catch (err) { setSaveStatus(""); setError("Could not save project: " + err.message); }
  }
  async function openSavedProject(project) {
    const savedDesign = project.design;
    setDesign(savedDesign);
    setSelected(savedDesign.document?.children?.[0]?.id || savedDesign.document?.id || null);
    setExpanded({ [savedDesign.document?.id]: true });
    setError("");
    setSaveStatus("Opened saved project");
    if (!savedDesign.assets?.length) {
      setError("This saved project has no stored image/vector assets. It was opened without contacting Figma; missing assets can only be restored when Figma access is available.");
    }
  }
  async function removeSavedProject(id) {
    try {
      const { error: deleteError } = await supabase.from("figma_user_projects").delete().eq("id", id);
      if (deleteError) throw deleteError;
      setSavedProjects(items => items.filter(project => project.id !== id));
      setSaveStatus("Saved project deleted");
    } catch (err) { setError("Could not delete saved project: " + err.message); }
  }

  function exportLayerDocs() {
    const docs=describeLayers(design.document,design.assets||[]),keys=["id","name","type","parent","hierarchy","position","layout","typography","appearance","text","asset"];
    const csv=[keys.join(","),...docs.map(row=>keys.map(k=>csvEscape(row[k])).join(","))].join("\n");
    downloadText("layer-descriptions.json",JSON.stringify(docs,null,2),"application/json");
    downloadText("layer-descriptions.csv",csv,"text/csv");
  }
  function unpackStoredZip(blob) {
    return blob.arrayBuffer().then(buffer => {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      const decoder = new TextDecoder();
      const files = [];
      let offset = 0;
      while (offset + 30 <= bytes.length) {
        const signature = view.getUint32(offset, true);
        if (signature === 0x02014b50 || signature === 0x06054b50) break;
        if (signature !== 0x04034b50) throw new Error("The generated project ZIP could not be read.");
        const flags = view.getUint16(offset + 6, true);
        const method = view.getUint16(offset + 8, true);
        const compressedSize = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        if (flags & 0x0008) throw new Error("This ZIP uses an unsupported data descriptor.");
        if (method !== 0) throw new Error("The project ZIP contains an unsupported compression method.");
        const nameStart = offset + 30;
        const dataStart = nameStart + nameLength + extraLength;
        const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)).replace(/\\/g, "/");
        const dataEnd = dataStart + compressedSize;
        if (dataEnd > bytes.length) throw new Error("The project ZIP is incomplete.");
        if (name && !name.endsWith("/") && !name.startsWith("/") && !name.split("/").includes("..")) {
          files.push({ path: name, data: bytes.slice(dataStart, dataEnd) });
        }
        offset = dataEnd;
      }
      if (!files.length) throw new Error("No files were found in the generated project ZIP.");
      return files;
    });
  }

  async function connectGithub(tokenOverride, persist = true) {
    const personalToken = String(tokenOverride || githubToken).trim();
    if (!personalToken) throw new Error("Paste your GitHub fine-grained token first.");
    setGithubRepoLoading(true);
    const headers = { Authorization: "Bearer " + personalToken, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    try {
      const userResponse = await fetch("https://api.github.com/user", { headers });
      const user = await userResponse.json().catch(() => ({}));
      if (!userResponse.ok) throw new Error(user.message || "GitHub could not verify this token.");
      if (persist) {
        await callFigmaFunction({ action: "save_github_token", githubToken: personalToken, retentionDays: githubRetentionDays });
        setGithubTokenStatus({ hasToken: true, retentionDays: githubRetentionDays, expiresAt: githubRetentionDays === 0 ? null : new Date(Date.now() + githubRetentionDays * 86400000).toISOString() });
      }

      const repositories = [];
      let nextUrl = "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";
      let pages = 0;
      while (nextUrl && pages < 10) {
        const response = await fetch(nextUrl, { headers });
        const page = await response.json().catch(() => []);
        if (!response.ok) throw new Error(page.message || "Could not list repositories. Check token access and Metadata: Read permission.");
        if (Array.isArray(page)) repositories.push(...page);
        const link = response.headers.get("Link") || "";
        const next = link.split(",").find(part => part.includes('rel="next"'));
        nextUrl = next ? next.match(/<([^>]+)>/)?.[1] || null : null;
        pages++;
      }
      const writable = repositories.filter(item => !item.archived && (item.permissions?.push || item.permissions?.admin || item.permissions?.maintain))
        .map(item => ({ id: item.id, full_name: item.full_name, private: item.private, default_branch: item.default_branch || "main", size: item.size || 0 }));
      setGithubRepos(writable);
      setGithubUsername(user.login || "");
      setGithubConnected(true);
      if (githubRepo && !writable.some(item => item.full_name === githubRepo)) setGithubRepo("");
      setSaveStatus("Connected to GitHub as @" + (user.login || "user") + ". Select a repository to continue.");
      setError("");
      if (!writable.length) throw new Error("GitHub connected, but no writable repositories were found. Give the token access to repositories and set Metadata: Read-only and Contents: Read and write.");
    } finally {
      setGithubRepoLoading(false);
    }
  }

  async function uploadZipToGithub(blob) {
    if (!githubToken.trim()) throw new Error("Connect GitHub first.");
    if (!githubRepo) throw new Error("Select a destination repository first.");
    const match = githubRepo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) throw new Error("Choose a valid destination repository from the list.");
    const [, owner, repository] = match;
    setGithubProgress({ active: true, stage: "Reading project files", current: 0, total: 0, percent: 2, fileName: "" });
    const files = await unpackStoredZip(blob);
    if (files.length > 500) throw new Error("This export contains more than 500 files. Split the export into smaller uploads.");
    const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > 45 * 1024 * 1024) throw new Error("This export is larger than 45 MB. Reduce the asset size and try again.");
    const headers = { Authorization: "Bearer " + githubToken.trim(), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    const api = "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repository);
    const request = async (url, options = {}) => {
      let lastError;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 60000);
          let response;
          try { response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: controller.signal }); }
          finally { clearTimeout(timeout); }
          const payload = await response.json().catch(() => ({}));
          if (response.ok) return payload;
          let message = payload.message || "GitHub API request failed (" + response.status + ").";
          if (response.status === 403 && /Resource not accessible by personal access token/i.test(message)) {
            message = "GitHub blocked this token. Open GitHub → Settings → Developer settings → Fine-grained tokens. Select this exact repository, set Metadata to Read-only and Contents to Read and write, then save. If the repository belongs to an organization, the token may also need organization approval or your account needs write access.";
          }
          if (response.status === 429 || response.status >= 500) { lastError = new Error(message); if (attempt < 3) { await new Promise(resolve => setTimeout(resolve, attempt * 1200)); continue; } }
          throw new Error(message);
        } catch (err) {
          lastError = err.name === "AbortError" ? new Error("GitHub request timed out after 60 seconds. Check your connection and retry.") : err;
          if (attempt >= 3 || (err.name !== "AbortError" && !/Failed to fetch|NetworkError/i.test(err.message || ""))) throw lastError;
          await new Promise(resolve => setTimeout(resolve, attempt * 1200));
        }
      }
      throw lastError || new Error("GitHub request failed.");
    };
    setGithubProgress({ active: true, stage: "Checking repository", current: 0, total: files.length, percent: 5, fileName: "" });
    const repoInfo = await request(api);
    const branch = githubBranch.trim() || repoInfo.default_branch || "main";
    const folder = githubPath.trim().replace(/^\/+|\/+$/g, "").replace(/\.\./g, "");
    if (folder && folder.split("/").some(part => part === "." || part === "")) throw new Error("Enter a valid destination folder.");
    const base64 = data => {
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < data.length; i += chunk) binary += String.fromCharCode(...data.subarray(i, i + chunk));
      return btoa(binary);
    };
    let baseCommit = null;
    let initialFileUploaded = false;
    const refUrl = api + "/git/ref/heads/" + encodeURIComponent(branch);
    const refResponse = await fetch(refUrl, { headers });
    if (refResponse.ok) {
      const ref = await refResponse.json();
      baseCommit = await request(api + "/git/commits/" + ref.object.sha);
    } else {
      const refError = await refResponse.json().catch(() => ({}));
      const refMessage = String(refError.message || "");
      const isEmptyRepository = /git repository is empty|repository is empty|no commits yet/i.test(refMessage) || refResponse.status === 409 || (refResponse.status === 404 && Number(repoInfo.size || 0) === 0);
      if (!isEmptyRepository) {
        if (refResponse.status === 404) throw new Error("Branch '" + branch + "' was not found. GitHub says: " + (refMessage || "Reference not found."));
        throw new Error(refMessage || "Could not read destination branch (HTTP " + refResponse.status + ").");
      }
      if (!files.length) throw new Error("There are no project files to upload.");
      setGithubProgress({ active: true, stage: "Creating the repository’s first commit", current: 0, total: files.length, percent: 6, fileName: files[0].path.split("/").pop() });
      const firstFile = files[0];
      const firstPath = [folder, firstFile.path].filter(Boolean).join("/");
      const contentUrl = api + "/contents/" + firstPath.split("/").map(encodeURIComponent).join("/");
      await request(contentUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Initialize repository with FigmaSpecs project files", content: base64(firstFile.data), branch }) });
      initialFileUploaded = true;
      setGithubProgress({ active: true, stage: "First commit created", current: 1, total: files.length, percent: Math.round(8 + (1 / files.length) * 72), fileName: firstFile.path.split("/").pop() });
      const createdRef = await request(refUrl);
      baseCommit = await request(api + "/git/commits/" + createdRef.object.sha);
    }    const entries = [];
    setGithubProgress({ active: true, stage: "Uploading individual files", current: 0, total: files.length, percent: 8, fileName: "" });
    for (let i = initialFileUploaded ? 1 : 0; i < files.length; i++) {
      const file = files[i];
      const shortName = file.path.split("/").pop();
      setGithubProgress({ active: true, stage: "Uploading file " + (i + 1) + " of " + files.length, current: i, total: files.length, percent: Math.round(8 + (i / files.length) * 72), fileName: shortName });
      const blobObject = await request(api + "/git/blobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: base64(file.data), encoding: "base64" })
      });
      entries.push({ path: [folder, file.path].filter(Boolean).join("/"), mode: "100644", type: "blob", sha: blobObject.sha });
      setGithubProgress({ active: true, stage: "Uploaded " + (i + 1) + " of " + files.length + " files", current: i + 1, total: files.length, percent: Math.round(8 + ((i + 1) / files.length) * 72), fileName: shortName });
    }
    setGithubProgress({ active: true, stage: "Creating Git tree", current: files.length, total: files.length, percent: 84, fileName: "" });
    const tree = await request(api + "/git/trees", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tree: entries, ...(baseCommit ? { base_tree: baseCommit.tree.sha } : {}) })
    });
    setGithubProgress({ active: true, stage: "Creating commit", current: files.length, total: files.length, percent: 91, fileName: "" });
    const commit = await request(api + "/git/commits", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Add FigmaSpecs project files (" + files.length + " files)", tree: tree.sha, parents: baseCommit ? [baseCommit.sha] : [] })
    });
    setGithubProgress({ active: true, stage: "Publishing commit to branch", current: files.length, total: files.length, percent: 97, fileName: "" });
    if (baseCommit) {
      await request(api + "/git/refs/heads/" + encodeURIComponent(branch), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha: commit.sha })
      });
    } else {
      await request(api + "/git/refs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "refs/heads/" + branch, sha: commit.sha })
      });
    }
    const successMessage = files.length + " individual files pushed to " + owner + "/" + repository + (folder ? " in " + folder : " at repository root") + ".";
    setSaveStatus(successMessage);
    setGithubProgress({ active: false, stage: "Upload complete", current: files.length, total: files.length, percent: 100, fileName: "" });
    setGithubToast({ type: "success", title: "Files pushed successfully", message: successMessage });
    setGithubUploadOpen(false);
  }

  function buildAiImplementationPrompt() {
    return [
      "# FigmaSpecs — AI Website Implementation Brief", "",
      "Act as a senior frontend engineer, UI/UX engineer and design-systems specialist. Recreate the supplied Figma design as a responsive, production-quality website.",
      "", "## Inspect before coding",
      "1. Inspect the connected GitHub repository, branch, package scripts, framework, dependencies, routes and existing components.",
      "2. Review every PNG in reference-frames/ and map it using design-data/frame-screenshots.json.",
      "3. Read design-data/complete-design.json for the complete Figma node tree.",
      "4. Read design-data/layer-descriptions.json and layer-descriptions.csv for hierarchy, measurements, Auto Layout and typography.",
      "5. Read design-data/design-tokens.css and use its tokens.",
      "6. Inspect assets/asset-manifest.json and use original files in assets/images/ and assets/vectors/.",
      "7. Review code/ as reference material, not as an assumed complete production implementation.",
      "", "## Implementation requirements",
      "- Explain repository architecture, available frames, assets, tokens and missing inputs before editing; provide a concise plan.",
      "- Preserve the existing framework, architecture, working features and conventions. Do not rewrite unrelated code.",
      "- Build reusable, focused components with semantic HTML, accessibility and maintainable CSS.",
      "- Match dimensions, spacing, typography, colors, borders, shadows, radii, image crops, alignment and visual hierarchy closely.",
      "- Use supplied assets and fonts. Never substitute placeholders, stock imagery, emoji or invented logos when originals exist.",
      "- Implement responsive desktop, tablet and mobile layouts. Where responsive references are absent, adapt carefully without changing the design language.",
      "- Do not invent important business logic or interactions. Ask when requirements are unclear.",
      "- Avoid duplicated CSS, oversized components, unnecessary dependencies, dead code, unexplained absolute positioning and console errors.",
      "", "## Verification",
      "Run the existing build and tests. Check imports, missing assets, console errors, accessibility, interactions, overflow and responsive layouts. Compare rendered pages against supplied screenshots at matching viewport sizes and correct mismatches section by section. Never claim pixel-perfect accuracy without actual visual comparison.",
      "", "## GitHub safety and final report",
      "Inspect the working tree and target branch before changes. Preserve unrelated work. Report exactly what changed and never claim a commit, push or deployment unless it succeeded.",
      "At completion, report completed sections, components, asset usage, responsive status, build/test results, remaining visual differences, missing assets and questions.",
      "", "## Project context",
      "Figma project: " + (design?.name || "Untitled Figma project"),
      "Detected layers: " + counts.layers + "; image fills: " + counts.images + "; vector layers: " + counts.vectors,
      "", "Primary rule: screenshots are the visual reference, Figma JSON/layer data is structural evidence, and supplied asset files are the source of truth. Achieve visual fidelity without sacrificing code quality or existing functionality."
    ].join("\n");
  }
  function buildCustomImplementationPrompt() {
    return [
      "# FigmaSpecs — Custom AI Implementation Prompt", "",
      "Act as a senior frontend engineer and UI implementation specialist. Implement the imported Figma design with high visual fidelity.",
      "", "## Project context",
      "Figma file: " + (design?.name || "Untitled"),
      "Frame: " + (design?.frameName || design?.document?.name || "Imported design"),
      "Detected layers: " + counts.layers + "; text: " + counts.text + "; images: " + counts.images + "; vectors: " + counts.vectors,
      "Target framework: " + promptFramework,
      "Styling approach: " + promptStyling,
      "Responsive targets: " + promptViewport,
      "", "## Workflow",
      "1. Inspect the existing repository, scripts, routes, dependencies and components before editing.",
      "2. Review the supplied Figma JSON, layer descriptions, design tokens, assets and reference screenshots.",
      "3. Explain the plan and identify missing assets or ambiguous requirements before coding.",
      "4. Reuse existing architecture, components and dependencies. Do not rewrite unrelated files.",
      "5. Match dimensions, spacing, typography, colors, shadows, radii, borders, image crops and alignment.",
      "6. Implement responsive behaviour for " + promptViewport + ".",
      "7. Keep code semantic, accessible, reusable and maintainable. Avoid placeholder assets and unnecessary dependencies.",
      "", "## Styling", promptStyling + ".",
      "", "## Additional requirements", promptExtra.trim() || "None supplied.",
      "", "## Verification",
      "Run the available build and tests. Check broken assets, console errors, interactions and responsive overflow. Compare screenshots at matching viewport sizes and correct visible differences. Never claim pixel-perfect accuracy without visual verification.",
      "Preserve unrelated work and report changed files, test results and remaining issues."
    ].join("\n");
  }
  async function copyCustomPrompt() {
    const value = generatedPrompt || buildCustomImplementationPrompt();
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(()=>setCopied(false),1800); }
    catch { downloadText("FIGMASPECS-CUSTOM-PROMPT.md",value,"text/markdown"); }
  }
  function buildAiSetupGuide() {
    return [
      "# FigmaSpecs AI Handoff Setup", "",
      "## 1. Upload the export to GitHub",
      "Create or choose a repository and upload the complete FigmaSpecs export. Preserve reference-frames/, assets/, design-data/ and code/ folders and all filenames.",
      "", "## 2. Connect GitHub to ChatGPT",
      "Connect GitHub from ChatGPT Settings > Apps / Connectors and authorize access to the target repository. Ask ChatGPT to inspect the repository before editing.",
      "", "## 3. Upload design context to ChatGPT",
      "Attach all reference-frame PNGs and these files: design-data/complete-design.json, frame-screenshots.json, layer-descriptions.json, design-tokens.css and assets/asset-manifest.json. For large projects, upload in manageable batches. Keep GitHub as the source of truth for the full asset library.",
      "", "## 4. Start implementation",
      "Copy AI-IMPLEMENTATION-PROMPT.md into the same ChatGPT conversation. Ask ChatGPT to inspect the repository and explain its plan before editing.",
      "", "## 5. Verify",
      "Ask ChatGPT to run the build/tests, check asset paths and responsive layouts, and compare rendered pages against supplied screenshots. Review changes before accepting them.",
      "", "Note: Connector availability and permissions depend on your account and workspace. Never share private tokens in chat or commit secrets to GitHub."
    ].join("\n");
  }
  function downloadAiHandoffFiles() {
    downloadText("AI-IMPLEMENTATION-PROMPT.md", buildAiImplementationPrompt(), "text/markdown");
    downloadText("AI-SETUP-GUIDE.md", buildAiSetupGuide(), "text/markdown");
  }

  async function downloadProjectZip(uploadToGithub = false) {
    if(!design?.document)return;
    setLoading(true);setError("");
    try{
      const docs=describeLayers(design.document,design.assets||[]),keys=["id","name","type","parent","hierarchy","position","layout","typography","appearance","text","asset"];
      const files=[
        {name:"AI-IMPLEMENTATION-PROMPT.md",data:buildAiImplementationPrompt()},
        {name:"AI-SETUP-GUIDE.md",data:buildAiSetupGuide()},
        {name:"design-data/complete-design.json",data:JSON.stringify(design,null,2)},
        {name:"design-data/layer-descriptions.json",data:JSON.stringify(docs,null,2)},
        {name:"design-data/layer-descriptions.csv",data:[keys.join(","),...docs.map(row=>keys.map(k=>csvEscape(row[k])).join(","))].join("\n")},
        {name:"design-data/design-tokens.css",data:cssTokens(allNodes)},
        {name:"assets/asset-manifest.json",data:JSON.stringify(design.assets||[],null,2)},
        {name:"README.md",data:"# "+(design.name||"Figma project")+"\n\nExported from FigmaSpecs.\n\n- design-data/complete-design.json: full extracted node tree and asset manifest\n- design-data/layer-descriptions.json: layer measurements, layout, typography and appearance\n- design-data/layer-descriptions.csv: spreadsheet-friendly layer inventory\n- design-data/design-tokens.css: extracted design tokens\n- assets/: downloaded image and vector assets\n"}
      ];
      const jsx="import React from 'react';\nimport './FigmaExport.css';\nexport default function FigmaExport(){return <main className=\"figma-root\">"+(design.document.children||[]).map(n=>"<section data-layer=\""+String(n.id||"").replace(/"/g,"")+"\">"+(n.type==="TEXT"?String(n.characters||"").replace(/</g,"&lt;"):(n.name||"Layer"))+"</section>").join("")+"</main>;}";
      files.push({name:"code/FigmaExport.jsx",data:jsx},{name:"code/FigmaExport.css",data:cssTokens(allNodes)+"\n.figma-root{position:relative;width:100%;}\n"});
      const exportAssets = await getFreshExportAssets(true);
      // ZIP export reuses cached screenshots only; it never calls Figma to render them.
      const frameScreenshots = (design.frameScreenshots || []).filter(item => item.path && item.url);
      const frameScreenshotWarning = (design.frameScreenshots || []).length && !frameScreenshots.length
        ? "Previously captured frame screenshots are not available in storage and were skipped."
        : "";
      files.find(file=>file.name==="assets/asset-manifest.json").data=JSON.stringify(exportAssets,null,2);
      files.push({name:"design-data/frame-screenshots.json",data:JSON.stringify(frameScreenshots.map(({url,...meta})=>meta),null,2)});
      if (frameScreenshots.length) {
        files.find(file=>file.name==="README.md").data += "- reference-frames/: high-resolution PNG screenshots of Figma frames for visual AI reference\n- design-data/frame-screenshots.json: frame names, node IDs and dimensions\n";
      } else {
        files.find(file=>file.name==="README.md").data += "- Frame screenshots were not available for this export; the complete design JSON and layer documentation are included.\n";
      }
      files.find(file=>file.name==="design-data/complete-design.json").data=JSON.stringify({...design,assets:exportAssets},null,2);
      const docsWithAssets=describeLayers(design.document,exportAssets);
      files.find(file=>file.name==="design-data/layer-descriptions.json").data=JSON.stringify(docsWithAssets,null,2);
      files.find(file=>file.name==="design-data/layer-descriptions.csv").data=[keys.join(","),...docsWithAssets.map(row=>keys.map(k=>csvEscape(row[k])).join(","))].join("\n");
      const skippedFiles = [];
      for (let i=0; i<frameScreenshots.length; i++) {
        const frame = frameScreenshots[i];
        try {
          const response = await fetch(frame.url);
          if (!response.ok) throw new Error("HTTP " + response.status);
          const bytes = new Uint8Array(await response.arrayBuffer());
          const frameSafeName = safeFileName(frame.name || frame.frameName, "frame-" + (i+1) + ".png");
          files.push({name:"reference-frames/"+String(i+1).padStart(3,"0")+"-"+frameSafeName,data:bytes});
        } catch (downloadError) {
          skippedFiles.push({name:frame.frameName || frame.name || "Unnamed frame screenshot",reason:downloadError.message || "Download failed"});
        }
      }
      let downloadedAssets = 0;
      const unavailableAssets = exportAssets.filter(asset => asset.unavailable);
      for(let i=0;i<exportAssets.length;i++){
        const asset=exportAssets[i];
        if(!asset.url) continue;
        try {
          const response=await fetch(asset.url);
          if(!response.ok) throw new Error("HTTP " + response.status);
          const bytes=new Uint8Array(await response.arrayBuffer());
          const safeName=safeFileName(asset.name,"asset-"+(i+1)+(asset.format==="svg"?".svg":".png"));
          files.push({name:(asset.format==="svg"?"assets/vectors/":"assets/images/")+String(i+1).padStart(3,"0")+"-"+safeName,data:bytes});
          downloadedAssets++;
        } catch (downloadError) {
          skippedFiles.push({name:asset.name || ("Asset " + (i+1)),reason:downloadError.message || "Download failed"});
        }
        if (uploadToGithub) setGithubProgress({active:true,stage:"Preparing image and vector assets",current:downloadedAssets,total:exportAssets.length,percent:Math.round(3+(downloadedAssets/Math.max(exportAssets.length,1))*4),fileName:asset.name || ""});
      }
      if(exportAssets.length && downloadedAssets===0 && !unavailableAssets.length) throw new Error("No image or vector assets could be downloaded. Check the asset storage and try again.");
      const safe=(design.name||"figma-project").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"figma-project";
      const bundle = zipBlob(files);
      if (uploadToGithub) await uploadZipToGithub(bundle);
      else saveBlob(safe+"-bundle.zip",bundle);
      const missingAssetWarning = unavailableAssets.length ? unavailableAssets.length + " image/vector asset(s) could not be recovered because Figma rate-limited the request; their metadata remains in the manifest." : "";
      const skippedFileWarning = skippedFiles.length ? skippedFiles.length + " file(s) were skipped during download: " + skippedFiles.map(item => item.name + " (" + item.reason + ")").join(", ") : "";
      if (frameScreenshotWarning || missingAssetWarning || skippedFileWarning) setError([frameScreenshotWarning,missingAssetWarning,skippedFileWarning].filter(Boolean).join(" "));
    }catch(err){if(uploadToGithub){setGithubProgress({active:false,stage:"Upload failed",current:0,total:0,percent:0,fileName:""});setGithubToast({type:"error",title:"GitHub upload failed",message:err.message||"Unknown upload error"});setError(err.message||"GitHub upload failed.");}else setError("ZIP export failed: "+(err.message||"Unknown error"));}
    finally{setLoading(false);}
  }


  const renderTree = (node, depth = 0) => {
    if (!node) return null;
    const hasChildren = node.children?.length > 0;
    return <React.Fragment key={node.id}>
      <button className={`layer-row ${selected === node.id ? "selected" : ""}`} style={{ paddingLeft: 12 + depth * 15 }} onClick={() => { setSelected(node.id); if (hasChildren) setExpanded(s => ({ ...s, [node.id]: !s[node.id] })); }}>
        {hasChildren ? <span className="tree-chevron">{expanded[node.id] ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}</span> : <span className="tree-spacer"/>}
        <NodeIcon type={node.type}/>
        <span className="layer-name">{node.name || "Untitled"}</span><span className="layer-type">{node.type?.toLowerCase().replaceAll("_"," ")}</span>
      </button>
      {hasChildren && expanded[node.id] && node.children.map(child => renderTree(child, depth + 1))}
    </React.Fragment>;
  };

  return <main className={`figma-studio theme-${themeMode}`} style={{ "--user-accent": accentColor, "--user-accent-soft": accentColor + "18" }}>
    <header className="studio-topbar">
      <a className="studio-brand" href="./"><span className="brand-mark"><Figma size={19}/></span><span>Figma<b>Specs</b></span></a>
      <div className="topbar-center"><span className="live-dot"/> Design extraction workspace <span className="topbar-divider"/> <span className="free-label">FREE-TIER FRIENDLY</span></div>
      <div className="account-actions"><span className="account-email">{session.user.email}</span><button className="github-connect-topbar" onClick={() => setGithubUploadOpen(true)} title="Connect a GitHub account"><Github size={15}/>{githubConnected ? "GitHub connected" : "Connect GitHub"}</button><button className="icon-button theme-trigger" onClick={() => setThemePanelOpen(v => !v)} title="Customize appearance" aria-label="Customize appearance"><Palette size={18}/></button><button className="icon-button" onClick={() => setShowSettings(v => !v)} title="Figma connection settings"><Settings2 size={18}/></button><button className="signout-button" onClick={onSignOut}>Sign out</button></div>
    </header>
    {themePanelOpen && <section className="theme-customizer" aria-label="Appearance settings">
      <div className="theme-customizer-head"><div><b>Customize your workspace</b><small>Choose an accent color and appearance</small></div><button className="icon-button" onClick={() => setThemePanelOpen(false)} aria-label="Close appearance settings"><X size={16}/></button></div>
      <div className="theme-mode-row"><span>Appearance</span><div className="theme-mode-options"><button type="button" className={themeMode === "light" ? "active" : ""} onClick={() => setThemeMode("light")}>Light</button><button type="button" className={themeMode === "dark" ? "active" : ""} onClick={() => setThemeMode("dark")}>Dark</button></div></div>
      <label className="theme-color-label" htmlFor="theme-accent-hex">Accent color</label>
      <div className="theme-color-controls"><input aria-label="Choose accent color" type="color" value={normalizeHex(accentDraft) || "#ff6600"} onChange={e => setAccentDraft(e.target.value)}/><input id="theme-accent-hex" type="text" value={accentDraft} onChange={e => setAccentDraft(e.target.value)} placeholder="#FF6600" maxLength={7}/><button type="button" className="theme-save-button" onClick={applyTheme} disabled={!isValidHex(accentDraft)}>Save</button></div>
      <div className="theme-presets"><span>Quick colors</span>{["#FF6600","#635BFF","#2878E5","#16A085","#D9468F","#7C5CFC"].map(color => <button key={color} type="button" aria-label={"Use "+color} title={color} style={{background:color}} onClick={() => setAccentDraft(color)}/>)}</div>
      <div className="theme-customizer-foot"><button type="button" onClick={resetTheme}>Reset to default</button>{savedThemeNotice && <span><Check size={13}/> Saved</span>}</div>
      <small className="theme-save-note">Your preference is saved on this browser for your account.</small>
    </section>}
    <section className="studio-content">
      <div className="intro-row">
        <div><div className="eyebrow"><Sparkles size={13}/> FIGMA DESIGN INSPECTOR</div><h1>From Figma to <span>pixel-perfect code.</span></h1><p>Read the real design values, inspect every layer and export the assets your website needs.</p></div>
        <div className="intro-chip"><LockKeyhole size={15}/> Private workspace · {tokenStatus.hasToken ? "Figma connected" : "Connect Figma to begin"}</div>
      </div>

      <form className="import-panel" onSubmit={importDesign}>
        <div className="import-heading"><div className="import-icon"><Figma size={21}/></div><div><strong>Import a Figma design</strong><small>Paste a design link. Choose a frame with the node-id parameter for a focused import.</small></div></div>
        <div className="import-fields">
          <label className="url-field"><Link2 size={17}/><input value={figmaUrl} onChange={e => setFigmaUrl(e.target.value)} placeholder="Paste Figma design URL here..." aria-label="Figma design URL"/></label>
          <div className="token-connected"><LockKeyhole size={16}/><span>{tokenStatus.hasToken ? "Figma token securely connected" : "Connect Figma in settings"}</span><button type="button" onClick={() => setShowSettings(true)}>Manage</button></div>
          <button className="import-button" disabled={importing}>{importing ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>} {importing ? "Reading design..." : "Import design"}</button>
        </div>
        {error && <div className="error-message"><CircleHelp size={15}/>{error}</div>}
        <div className="import-foot"><span><Check size={13}/> No Figma MCP required</span><span><Check size={13}/> No Dev Mode dependency</span><button type="button" onClick={() => setShowSettings(v => !v)}>Connection settings <ChevronDown size={13}/></button></div>
        {showSettings && <div className="settings-panel token-settings"><div className="token-settings-head"><b>Figma connection</b><small>{tokenStatus.hasToken ? "Your token is encrypted and stored securely." : "Connect your Figma personal access token."}</small></div><div className="token-label-row"><label htmlFor="figma-personal-token">Figma personal access token</label><button type="button" className="token-help-toggle" onClick={()=>setShowFigmaTokenHelp(v=>!v)} aria-expanded={showFigmaTokenHelp}> <CircleHelp size={13}/> {showFigmaTokenHelp?"Hide guide":"How to find?"}</button></div><input id="figma-personal-token" type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder={tokenStatus.hasToken ? "Enter a new token to replace current token" : "Paste your Figma personal access token"} autoComplete="off"/>{showFigmaTokenHelp && <div className="token-help-panel"><b>Find your Figma token</b><ol><li>Open <a href="https://www.figma.com/" target="_blank" rel="noreferrer">Figma</a> and sign in.</li><li>Open your account menu and choose <b>Settings</b>.</li><li>Go to the <b>Security</b> tab and scroll to <b>Personal access tokens</b>.</li><li>Choose <b>Generate new token</b>, give it a name and select the scopes <code>file_content:read</code> and <code>current_user:read</code>.</li><li>Generate the token and copy it immediately, then paste it above.</li></ol><a className="token-doc-link" href="https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens" target="_blank" rel="noreferrer">Figma's official token guide <ArrowRight size={12}/></a><small>Figma shows the token only once. Keep it private.</small></div>}<label>How long should we keep it saved?<select value={retentionDays} onChange={e=>setRetentionDays(Number(e.target.value))}><option value={0}>Until I remove it</option><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label><small>Token is encrypted server-side and never stored in browser storage. “Until I remove it” keeps it saved until you delete it.</small><div className="token-settings-actions"><button type="button" className="save-token-button" disabled={!token.trim() || tokenSaving} onClick={saveFigmaToken}>{tokenSaving ? "Validating…" : tokenStatus.hasToken ? "Update token" : "Connect Figma"}</button>{tokenStatus.hasToken && <button type="button" className="remove-token-button" onClick={removeFigmaToken}>Remove token</button>}</div></div>}
      </form>

      {!design ? <>{savedProjects.length > 0 && <section className="saved-projects"><div className="saved-projects-head"><div><b>Your saved projects</b><small>Private cloud library · {savedProjects.length} projects{!storageReady ? " · Loading…" : ""}</small></div></div><div className="saved-project-list">{savedProjects.map(project => <div className="saved-project-row" key={project.id}><button onClick={() => openSavedProject(project)}><FileJson size={16}/><span><b>{project.name}</b><small>Frame: {project.design?.frameName || "All frames"}</small><small>Saved {new Date(project.savedAt).toLocaleString()}</small></span></button><button aria-label="Remove saved project" onClick={() => removeSavedProject(project.id)}><X size={15}/></button></div>)}</div></section>}
      <div className="empty-state"><div className="empty-illustration"><div className="empty-card card-back"/><div className="empty-card card-front"><Layers3 size={30}/><span/><span/></div><div className="empty-spark spark-one">✳</div><div className="empty-spark spark-two">✦</div></div><h2>Your design workspace is ready</h2><p>Import a Figma file to inspect its structure, typography, colors, measurements and downloadable assets.</p><div className="empty-capabilities"><span><Type size={15}/> Typography</span><span><Palette size={15}/> Colors</span><span><Ruler size={15}/> Spacing</span><span><ImageIcon size={15}/> Assets</span></div></div></>
      : <div className="workspace">
        <div className="project-heading"><div><div className="eyebrow">IMPORTED FILE</div><h2>{design.name || "Untitled Figma file"}</h2><small className="project-frame-label">Frame: <b>{design.frameName || "All frames"}</b> · {design.lastModified ? "Last modified " + new Date(design.lastModified).toLocaleString() : "Figma design file"} · {counts.layers} layers detected</small></div><div className="export-actions"><button className="secondary-button" onClick={()=>setShowAiHandoff(v=>!v)}><Sparkles size={15}/> AI Handoff</button><button className="secondary-button" onClick={saveCurrentProject} disabled={saveStatus === "Saving…"}><Check size={15}/> {saveStatus === "Saving…" ? "Saving…" : "Save project"}</button><button className="primary-small" onClick={()=>downloadProjectZip(false)} disabled={loading}><ArrowDownToLine size={15}/> {loading ? "Building ZIP..." : "Download full project"}</button><button className="secondary-button" onClick={()=>githubConnected && githubRepo ? downloadProjectZip(true) : setGithubUploadOpen(true)} disabled={loading}><Github size={15}/> {githubConnected?"Push to GitHub":"Connect GitHub"}</button><div className="more-exports-wrap"><button className="secondary-button more-exports-toggle" onClick={()=>setShowMoreExports(v=>!v)} aria-expanded={showMoreExports}><Layers3 size={15}/> More exports <ChevronDown size={14}/></button>{showMoreExports && <div className="more-exports-menu"><button onClick={()=>{exportJson();setShowMoreExports(false);}}><FileJson size={15}/> Design JSON</button><button onClick={()=>{exportTokens();setShowMoreExports(false);}}><Code2 size={15}/> CSS design tokens</button><button onClick={()=>{exportReact();setShowMoreExports(false);}} disabled={loading}><Code2 size={15}/> React + CSS bundle</button><button onClick={()=>{exportLayerDocs();setShowMoreExports(false);}}><Layers3 size={15}/> Layer documentation (JSON + CSV)</button></div>}</div></div></div>
        {showAiHandoff && <section className="ai-handoff-panel">
          <div className="ai-handoff-heading"><div><span className="eyebrow">AI-READY DEVELOPMENT PACKAGE</span><h3>Take this design from Figma to a working website</h3><p>Upload the export to GitHub, connect that repository to ChatGPT, then provide the visual references and implementation prompt.</p></div><button className="icon-button" onClick={()=>setShowAiHandoff(false)} aria-label="Close AI handoff"><X size={17}/></button></div>
          <div className="ai-handoff-steps">
            <article><b><Github size={16}/> 1. Upload to GitHub</b><p>Push the complete export folder, preserving reference frames, assets, design data and code.</p></article>
            <article><b><Link2 size={16}/> 2. Connect GitHub to ChatGPT</b><p>Authorize ChatGPT to access the target repository and ask it to inspect the codebase first.</p></article>
            <article><b><FileImage size={16}/> 3. Upload design context</b><p>Attach frame PNGs plus complete-design.json, frame-screenshots.json, layer-descriptions.json, design-tokens.css and asset-manifest.json.</p></article>
            <article><b><Sparkles size={16}/> 4. Paste the prompt</b><p>Use AI-IMPLEMENTATION-PROMPT.md to guide visual accuracy, responsive behaviour, code quality and verification.</p></article>
          </div>
          <div className="ai-handoff-actions"><button className="secondary-button" onClick={()=>downloadText("AI-IMPLEMENTATION-PROMPT.md",buildAiImplementationPrompt(),"text/markdown")}><Copy size={14}/> Download implementation prompt</button><button className="secondary-button" onClick={()=>downloadText("AI-SETUP-GUIDE.md",buildAiSetupGuide(),"text/markdown")}><FileJson size={14}/> Download setup guide</button><button className="primary-small" onClick={downloadAiHandoffFiles}><ArrowDownToLine size={14}/> Download both guides</button></div>
          <p className="ai-handoff-note">The project ZIP and GitHub push include both AI handoff documents automatically.</p>
        </section>}
        <section className="new-tools-grid">
          <button className="new-tool-card" onClick={()=>setComparisonOpen(v=>!v)}><span className="new-tool-icon"><Ruler size={19}/></span><span><b>Design vs Code Comparison</b><small>Overlay design and implementation screenshots.</small></span><ChevronDown size={16}/></button>
          <button className="new-tool-card" onClick={()=>{setPromptBuilderOpen(v=>!v);setGeneratedPrompt("");}}><span className="new-tool-icon"><Sparkles size={19}/></span><span><b>AI Prompt Builder</b><small>Generate a project-aware implementation brief.</small></span><ChevronDown size={16}/></button>
        </section>
        {comparisonOpen && <section className="tool-panel">
          <div className="tool-panel-heading"><div><b>Design vs Code Comparison</b><small>Capture both at the same viewport size and scroll position.</small></div><button className="icon-button" onClick={()=>setComparisonOpen(false)} aria-label="Close comparison"><X size={16}/></button></div>
          <div className="comparison-upload-grid">
            <label>Figma reference screenshot<input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f)setReferenceImage(URL.createObjectURL(f));}}/></label>
            <label>Implemented website screenshot<input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f)setImplementationImage(URL.createObjectURL(f));}}/></label>
          </div>
          {referenceImage && implementationImage ? <><div className="comparison-stage"><img src={referenceImage} alt="Figma reference screenshot"/><img className="comparison-overlay" src={implementationImage} alt="Website implementation overlay" style={{opacity:comparisonOpacity/100}}/></div><label className="comparison-slider">Implementation overlay <input type="range" min="0" max="100" value={comparisonOpacity} onChange={e=>setComparisonOpacity(Number(e.target.value))}/><b>{comparisonOpacity}%</b></label></> : <p className="comparison-empty">Upload both screenshots to compare them with an adjustable overlay.</p>}
        </section>}
        {promptBuilderOpen && <section className="tool-panel prompt-builder">
          <div className="tool-panel-heading"><div><b>AI Prompt Builder</b><small>Uses this import's project name and extracted layer counts.</small></div><button className="icon-button" onClick={()=>setPromptBuilderOpen(false)} aria-label="Close prompt builder"><X size={16}/></button></div>
          <div className="prompt-fields-grid">
            <label>Target framework<select value={promptFramework} onChange={e=>setPromptFramework(e.target.value)}><option>Detect from repository</option><option>React + Vite</option><option>Next.js</option><option>HTML, CSS and JavaScript</option><option>Vue</option><option>Angular</option></select></label>
            <label>Styling approach<select value={promptStyling} onChange={e=>setPromptStyling(e.target.value)}><option>Use the existing styling approach</option><option>CSS Modules</option><option>Plain CSS</option><option>Bootstrap</option><option>Tailwind CSS</option><option>Styled Components</option></select></label>
            <label>Responsive targets<select value={promptViewport} onChange={e=>setPromptViewport(e.target.value)}><option>Desktop, tablet and mobile</option><option>Desktop only</option><option>Mobile first, then tablet and desktop</option><option>Tablet and desktop</option></select></label>
            <label className="prompt-extra">Additional instructions<textarea rows="3" value={promptExtra} onChange={e=>setPromptExtra(e.target.value)} placeholder="e.g. Reuse the existing header and footer; use GSAP for subtle animations…"/></label>
          </div>
          <div className="prompt-builder-actions"><button className="primary-small" onClick={()=>setGeneratedPrompt(buildCustomImplementationPrompt())}><Sparkles size={15}/> Generate prompt</button>{generatedPrompt && <><button className="secondary-button" onClick={copyCustomPrompt}><Copy size={14}/> Copy prompt</button><button className="secondary-button" onClick={()=>downloadText("FIGMASPECS-CUSTOM-PROMPT.md",generatedPrompt,"text/markdown")}><ArrowDownToLine size={14}/> Download .md</button></>}</div>
          {generatedPrompt && <textarea className="generated-prompt-output" readOnly value={generatedPrompt} rows="12" aria-label="Generated implementation prompt"/>}
        </section>}
        {githubUploadOpen && <div className="github-modal-backdrop" role="presentation" onClick={e=>{if(e.target===e.currentTarget)setGithubUploadOpen(false);}}><section className="github-modal" role="dialog" aria-modal="true" aria-labelledby="github-upload-title">
          <div className="github-modal-head"><div><span className="github-modal-icon"><Github size={19}/></span><div><h3 id="github-upload-title">{githubConnected ? "GitHub connected" : "Connect GitHub"}</h3><p>{githubConnected ? "Choose the repository where FigmaSpecs should commit your project files." : "Connect your GitHub account first. You can select a repository in the next step."}</p></div></div><button type="button" className="github-modal-close" onClick={()=>setGithubUploadOpen(false)} aria-label="Close"><X size={18}/></button></div>
          <form onSubmit={async e=>{e.preventDefault();setGithubBusy(true);setError("");try{if(!githubConnected){await connectGithub();}else{if(!githubRepo)throw new Error("Select a repository before continuing.");setGithubUploadOpen(false);setSaveStatus("GitHub ready: "+githubRepo+". Import a design and choose Push files to GitHub.");}}catch(err){setError(err.message||"GitHub connection failed.");}finally{setGithubBusy(false);}}}>
            {!githubConnected && !githubTokenStatus.hasToken ? <>
              <div><div className="token-label-row"><label htmlFor="github-personal-token">GitHub fine-grained personal access token</label><button type="button" className="token-help-toggle" onClick={()=>setShowGithubTokenHelp(v=>!v)} aria-expanded={showGithubTokenHelp}><CircleHelp size={13}/>{showGithubTokenHelp?"Hide guide":"How to find?"}</button></div><input id="github-personal-token" type="password" value={githubToken} onChange={e=>setGithubToken(e.target.value)} placeholder="github_pat_…" required autoComplete="off"/>{showGithubTokenHelp && <div className="token-help-panel"><b>Create a GitHub token</b><ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">GitHub fine-grained tokens</a> and sign in.</li><li>Enter a token name and choose an expiration.</li><li>Under <b>Resource owner</b>, select the account or organization that owns the repository.</li><li>Under <b>Repository access</b>, choose <b>All repositories</b> or select the repository you want to use.</li><li>Under <b>Repository permissions</b>, set <b>Metadata</b> to <b>Read-only</b> and <b>Contents</b> to <b>Read and write</b>.</li><li>Click <b>Generate token</b> and copy it immediately.</li></ol><a className="token-doc-link" href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" target="_blank" rel="noreferrer">GitHub's official token guide <ArrowRight size={12}/></a><small>Your token is encrypted in your FigmaSpecs account after GitHub verifies it.</small></div>}</div>
              <div className="github-retention-row"><label htmlFor="github-retention">Keep GitHub token saved for</label><select id="github-retention" value={githubRetentionDays} onChange={e=>setGithubRetentionDays(Number(e.target.value))}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>Until I remove it</option></select></div><small className="github-token-help">Your token is encrypted in your FigmaSpecs account and restored automatically when you sign in. Permissions required: Metadata (read-only), Contents (read and write), and access to the selected repository.</small>
            </> : <>
              {!githubConnected && <div className="github-saved-token-panel"><div className="github-connected-banner"><span className="github-connected-check"><Check size={15}/></span><span><b>GitHub token already saved</b><small>Encrypted in your account · {githubTokenStatus.retentionDays===0?"Until removed":(githubTokenStatus.retentionDays||githubRetentionDays)+" days"}</small></span><button type="button" onClick={async()=>{try{await callFigmaFunction({action:"delete_github_token"});setGithubToken("");setGithubTokenStatus({hasToken:false});setGithubConnected(false);setGithubRepos([]);setGithubRepo("");setSaveStatus("GitHub token removed.");}catch(err){setError(err.message);}}}>Forget token</button></div><p>Your saved token is available. FigmaSpecs only needs to reconnect to GitHub and load your repositories.</p><button type="button" className="secondary-button" disabled={githubBusy} onClick={async()=>{setGithubBusy(true);setError("");try{await connectGithub(githubToken,false);}catch(err){setError(err.message);setGithubToast({type:"error",title:"Could not load GitHub repositories",message:err.message});}finally{setGithubBusy(false);}}}>{githubBusy?<LoaderCircle className="spin" size={14}/>:<Github size={14}/>} Retry GitHub connection</button></div>}
              {githubConnected && <div className="github-connected-banner"><span className="github-connected-check"><Check size={15}/></span><span>Connected as <b>@{githubUsername}</b><small>Token saved · {githubTokenStatus.retentionDays===0?"Until removed":(githubTokenStatus.retentionDays||githubRetentionDays)+" days"}</small></span><button type="button" onClick={async()=>{try{await callFigmaFunction({action:"delete_github_token"});setGithubToken("");setGithubConnected(false);setGithubRepos([]);setGithubRepo("");setGithubTokenStatus({hasToken:false});setSaveStatus("GitHub token removed.");}catch(err){setError(err.message);}}}>Forget token</button></div>} {githubConnected && <><div className="github-retention-row"><label htmlFor="github-retention-saved">Keep token saved for</label><select id="github-retention-saved" value={githubRetentionDays} onChange={async e=>{const days=Number(e.target.value);setGithubRetentionDays(days);try{await callFigmaFunction({action:"save_github_token",githubToken,retentionDays:days});setGithubTokenStatus({hasToken:true,retentionDays:days,expiresAt:days===0?null:new Date(Date.now()+days*86400000).toISOString()});setGithubToast({type:"success",title:"Retention updated",message:"Your GitHub token retention preference has been saved."});}catch(err){setError(err.message);}}}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>Until I remove it</option></select></div>
              <label htmlFor="github-repository-select">Select repository</label>
              <select id="github-repository-select" className="github-repository-select" value={githubRepo} onChange={e=>{const selectedRepo=githubRepos.find(r=>r.full_name===e.target.value);setGithubRepo(e.target.value);setGithubBranch(selectedRepo?.default_branch||"main");}} required>
                <option value="">Choose a repository…</option>
                {githubRepos.map(item=><option key={item.id} value={item.full_name}>{item.full_name}{item.private?" · Private":" · Public"}</option>)}
              </select>
              <div className="github-modal-row"><label>Branch<input value={githubBranch} onChange={e=>setGithubBranch(e.target.value)} placeholder="Default branch (main)"/></label><label>Folder in repository<input value={githubPath} onChange={e=>setGithubPath(e.target.value)} placeholder="figmaspecs-exports"/></label></div>
              <small className="github-token-help">Empty repositories are supported. FigmaSpecs will create their first commit and branch automatically. Existing repositories receive a new commit that preserves their other files.</small>
              </>}
            </>}
            {error && <div className="github-upload-error" role="alert"><CircleHelp size={14}/><span>{error}</span></div>}
            {saveStatus && <div className="github-upload-status" role="status">{saveStatus}</div>}
            <div className="github-modal-actions"><button type="button" className="secondary-button" onClick={()=>setGithubUploadOpen(false)}>Cancel</button><button type="submit" className="primary-small" disabled={githubBusy||(!githubConnected&&!githubToken.trim())||(githubConnected&&!githubRepos.length)}>{githubBusy?<LoaderCircle className="spin" size={15}/>:<Github size={15}/>} {githubBusy?(githubConnected?"Saving…":"Connecting…"):(githubConnected?"Save repository":(githubTokenStatus.hasToken?"Retry repository access":"Connect GitHub"))}</button></div>
          </form>
          <p className="github-modal-foot">{githubConnected?"After saving, import a Figma design and use Push files to GitHub. Every asset, JSON, CSS, JSX and README is committed as an individual file.":"First connect your token. FigmaSpecs will list repositories it can access, then you can choose one from a dropdown."}</p>
        </section></div>}
        {githubProgress.active && <div className="github-progress-card" role="status" aria-live="polite">
          <div className="github-progress-heading"><span className="github-progress-spinner"><LoaderCircle size={17}/></span><div><b>{githubProgress.stage}</b><small>{githubProgress.fileName ? "Current file: "+githubProgress.fileName : "Sending project files to GitHub"}</small></div><strong>{githubProgress.percent}%</strong></div>
          <div className="github-progress-track"><div className="github-progress-fill" style={{width:githubProgress.percent+"%"}}/></div>
          <div className="github-progress-foot"><span>{githubProgress.current} of {githubProgress.total || "—"} files</span><span>Please keep this tab open</span></div>
        </div>}
        {githubToast && <div className={"github-toast "+(githubToast.type==="success"?"is-success":"is-error")} role="alert" aria-live="assertive"><span className="github-toast-icon">{githubToast.type==="success"?<CheckCircle2 size={19}/>:<CircleAlert size={19}/>}</span><div><b>{githubToast.title}</b><p>{githubToast.message}</p></div><button type="button" onClick={()=>setGithubToast(null)} aria-label="Dismiss notification"><X size={15}/></button></div>}
        {saveStatus && <div className="save-status" role="status">{saveStatus}</div>}<div className="stat-grid"><Stat icon={<Layers3/>} label="Total layers" value={counts.layers}/><Stat icon={<Type/>} label="Text layers" value={counts.text}/><Stat icon={<ImageIcon/>} label="Image fills" value={counts.images}/><Stat icon={<Frame/>} label="Vector layers" value={counts.vectors}/></div>
        <div className="inspector-layout">
          <section className="panel layers-panel"><div className="panel-heading"><div><Layers3 size={17}/><b>Layers</b><span className="count-pill">{counts.layers}</span></div></div><div className="layer-search"><Search size={15}/><input placeholder="Search layers..." value={query} onChange={e => setQuery(e.target.value)}/><kbd>⌘ K</kbd></div><div className="layer-list">{query ? filteredNodes.slice(0,120).map(n => <button key={n.id} className={`layer-row ${selected===n.id?"selected":""}`} onClick={() => setSelected(n.id)}><NodeIcon type={n.type}/><span className="layer-name">{n.name}</span><span className="layer-type">{n.type}</span></button>) : renderTree(design.document)}</div></section>
          <section className="panel details-panel"><div className="detail-tabs"><button className={activeTab==="layers"?"active":""} onClick={()=>setActiveTab("layers")}>Properties</button><button className={activeTab==="assets"?"active":""} onClick={()=>setActiveTab("assets")}>Assets <span>{design.assets?.length || 0}</span></button></div>
            {activeTab==="assets" ? <div className="assets-grid">{(design.assets||[]).map((asset,i)=><a key={asset.nodeId} className="asset-card" href={asset.url} target="_blank" rel="noreferrer"><div className="asset-preview">{asset.format==="svg"?<Code2/>:<FileImage/>}</div><b>{asset.name || "Asset " + (i+1)}</b><small>{asset.format?.toUpperCase()} · {asset.nodeId}</small></a>)}{!design.assets?.length&&<div className="no-selection">No exportable assets detected.</div>}</div>
            : selectedNode ? <PropertyInspector node={selectedNode} copied={copied} onCopy={copyText}/> : <div className="no-selection">Select a layer to inspect its design properties.</div>}
          </section>
        </div>
        <div className="workspace-note"><Activity size={15}/><span>Values are extracted from Figma's node data. Auto Layout values are shown separately from absolute position so you can reproduce responsive behaviour accurately.</span></div>
      </div>}
      <footer className="studio-footer"><span>FigmaSpecs <span className="footer-dot">·</span> Figma Importer</span><span>Built with Figma REST API + Supabase Edge Functions</span></footer>
    </section>
  </main>;
}

function NodeIcon({type}) {
  const common={size:14,strokeWidth:1.8};
  if(type==="TEXT") return <Type {...common} className="node-type-text"/>;
  if(type==="FRAME"||type==="COMPONENT"||type==="INSTANCE") return <Frame {...common} className="node-type-frame"/>;
  if(type==="VECTOR"||type==="BOOLEAN_OPERATION") return <PenIcon/>;
  if(type==="RECTANGLE"||type==="ELLIPSE"||type==="LINE") return <Box {...common}/>;
  return <Layers3 {...common}/>;
}
function PenIcon(){return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4 20 4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z"/></svg>}
function Stat({icon,label,value}){return <div className="stat-card"><span className="stat-icon">{React.cloneElement(icon,{size:17})}</span><div><b>{value.toLocaleString()}</b><small>{label}</small></div></div>}
function PropertyInspector({node,copied,onCopy}){
  const box=node.absoluteBoundingBox||{}; const style=node.style||{}; const layout=node.layoutMode||"";
  const fills=(node.fills||[]).filter(f=>f.visible!==false); const strokes=(node.strokes||[]).filter(f=>f.visible!==false);
  const textValue=[node.characters, node.name].filter(Boolean).join("\n");
  const groups=[
    {title:"Dimensions & position",icon:<Ruler/>,rows:[["X",px(box.x)],["Y",px(box.y)],["Width",px(box.width)],["Height",px(box.height)],["Rotation",node.rotation!=null?node.rotation+"°":"—"]]},
    {title:"Auto Layout & spacing",icon:<Layers3/>,rows:[["Layout mode",layout||"None"],["Direction",node.primaryAxisAlignItems||"—"],["Item gap",px(node.itemSpacing)],["Padding top",px(node.paddingTop)],["Padding right",px(node.paddingRight)],["Padding bottom",px(node.paddingBottom)],["Padding left",px(node.paddingLeft)],["Cross-axis gap",px(node.counterAxisSpacing)]]},
    {title:"Typography",icon:<Type/>,rows:[["Font family",style.fontFamily||"—"],["Font style",style.fontPostScriptName||"—"],["Weight",style.fontWeight||"—"],["Size",px(style.fontSize)],["Line height",style.lineHeightPx?px(style.lineHeightPx):style.lineHeightPercent?style.lineHeightPercent+"%":"—"],["Letter spacing",style.letterSpacing!=null?px(style.letterSpacing):"—"],["Text align",style.textAlignHorizontal||"—"]]},
    {title:"Appearance",icon:<Palette/>,rows:[["Opacity",node.opacity!=null?Math.round(node.opacity*100)+"%":"—"],["Corner radius",node.cornerRadius!=null?px(node.cornerRadius):"—"],["Blend mode",node.blendMode||"—"],["Clips content",node.clipsContent?"Yes":"No"]]}
  ];
  return <div className="property-content"><div className="selected-layer"><div><NodeIcon type={node.type}/><b>{node.name||"Untitled layer"}</b></div><small>{node.type} · {node.id}</small></div>
    {groups.map((g,i)=><section className="property-group" key={g.title}><h4>{g.icon}{g.title}</h4><div className="property-grid">{g.rows.map(([k,v])=><div className="property-row" key={k}><span>{k}</span><b>{v}</b></div>)}</div></section>)}
    <section className="property-group"><h4><Palette/> Fills & strokes</h4>{fills.length?fills.map((f,i)=><div className="paint-row" key={i}><span className="paint-swatch" style={{background:f.type==="SOLID"?rgba(f.color):"linear-gradient(135deg,#aaa,#eee)"}}/><span>{f.type==="SOLID"?rgba(f.color,f.opacity??1):f.type}</span><small>{f.opacity!=null?Math.round(f.opacity*100)+"%":"100%"}</small></div>):<div className="muted-line">No visible fills</div>}{strokes.map((f,i)=><div className="paint-row" key={"s"+i}><span className="paint-swatch stroke-swatch" style={{background:f.type==="SOLID"?rgba(f.color):"#fff"}}/><span>Stroke · {f.type==="SOLID"?rgba(f.color):f.type}</span></div>)}</section>
    {node.characters&&<section className="property-group"><div className="group-title-action"><h4><Type/> Text content</h4><button onClick={()=>onCopy(textValue)}><Copy size={13}/>{copied?"Copied":"Copy text"}</button></div><div className="text-content-preview">{node.characters}</div></section>}
  </div>;
}
