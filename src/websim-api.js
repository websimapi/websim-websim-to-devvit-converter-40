// WebSim API Integration
// Re-using the logic provided in the prompt, structured as an ES Module

const API_BASE = '/api/v1';

async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    console.log(`[WebSimAPI] Requesting: ${url}`);
    
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WebSimAPI] Request Failed: ${url} (${response.status})`, errorText);
        throw new Error(`API Error ${response.status}: ${errorText}`);
    }
    
    return response.json();
}

async function fetchRaw(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
}

export function getProjectById(projectId) {
    return makeRequest(`/projects/${projectId}`);
}

export function getProjectBySlug(username, slug) {
    return makeRequest(`/users/${username}/slugs/${slug}`);
}

export function getProjectRevisions(projectId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return makeRequest(`/projects/${projectId}/revisions?${query}`);
}

export async function getAllProjectRevisions(projectId) {
    let allRevisions = [];
    let hasNextPage = true;
    let afterCursor = null;

    // Safety limit to prevent infinite loops on massive histories
    let pageCount = 0;
    const MAX_PAGES = 10;

    while (hasNextPage && pageCount < MAX_PAGES) {
        const params = { first: 50 };
        if (afterCursor) {
            params.after = afterCursor;
        }

        try {
            const response = await getProjectRevisions(projectId, params);
            if (response.revisions && response.revisions.data) {
                allRevisions = allRevisions.concat(response.revisions.data);
            }
            
            hasNextPage = response.revisions?.meta?.has_next_page || false;
            afterCursor = response.revisions?.meta?.end_cursor;
            
            if (!afterCursor) hasNextPage = false;
        } catch (e) {
            console.warn("Error fetching revision page", e);
            hasNextPage = false;
        }
        pageCount++;
    }

    return allRevisions;
}

export async function getAssetMetadata(projectId, version, path) {
    try {
        return await makeRequest(`/projects/${projectId}/revisions/${version}/assets/${encodeURIComponent(path)}`);
    } catch(e) {
        return null;
    }
}

export async function getAssets(projectId, version) {
    console.log(`[WebSimAPI] getAssets: Project=${projectId}, Version=${version}`);
    
    // 1. Fetch Revision Metadata first (contains critical file maps & content)
    let revisionFiles = {};
    try {
        console.log(`[WebSimAPI] Fetching full revision metadata to enrich assets...`);
        const revRes = await makeRequest(`/projects/${projectId}/revisions/${version}`);
        const rev = revRes.revision || revRes;
        
        // Check for 'files' (common) or 'assets' (sometimes used for maps)
        if (rev.files) {
            console.log(`[WebSimAPI] Revision metadata contains ${Object.keys(rev.files).length} files.`);
            revisionFiles = rev.files;
        }
    } catch(e) {
        console.warn("[WebSimAPI] Failed to fetch revision metadata for asset enrichment (non-fatal):", e);
    }

    let allAssets = [];
    let nextCursor = null;
    let hasNext = true;
    let page = 0;
    
    while(hasNext && page < 50) { // Safety limit
        console.log(`[WebSimAPI] Fetching asset page ${page}...`);
        const params = new URLSearchParams();
        params.set('first', '50');
        if (nextCursor) params.set('after', nextCursor);

        try {
            const res = await makeRequest(`/projects/${projectId}/revisions/${version}/assets?${params}`);
            
            let pageData = [];
            let meta = null;

            if (Array.isArray(res)) {
                pageData = res;
                hasNext = false; 
            } else if (res.assets && Array.isArray(res.assets)) {
                pageData = res.assets;
                hasNext = false;
            } else if (res.assets && res.assets.data && Array.isArray(res.assets.data)) {
                pageData = res.assets.data;
                meta = res.assets.meta;
            } else if (res.data && Array.isArray(res.data)) {
                pageData = res.data;
                meta = res.meta;
            }

            console.log(`[WebSimAPI] Page ${page} found ${pageData.length} assets.`);
            
            if (pageData.length > 0) {
                // Enrich assets with Revision Metadata (Fixes missing URLs/Content)
                const enriched = pageData.map(asset => {
                    const fname = asset.path ? asset.path.replace(/^\//, '') : '';
                    // Try exact match or match without leading slash
                    const revFile = revisionFiles[fname] || revisionFiles['/' + fname] || revisionFiles[asset.path];
                    
                    if (revFile) {
                        // Merge strategies: Prefer Revision URL/Content over Asset List defaults
                        const merged = { ...asset, ...revFile };
                        
                        // Ensure critical fields are promoted
                        merged.url = revFile.url || revFile.src || revFile.download_url || asset.url || asset.src || asset.download_url;
                        if (revFile.content !== undefined) merged.content = revFile.content;
                        
                        return merged;
                    }
                    return asset;
                });
                
                allAssets.push(...enriched);
            }

            if (meta && meta.has_next_page && meta.end_cursor) {
                nextCursor = meta.end_cursor;
            } else {
                hasNext = false;
            }
        } catch(e) {
            console.error(`[WebSimAPI] Asset fetch page ${page} failed:`, e);
            hasNext = false;
        }
        page++;
    }

    // Also inject any files found in Revision but missing from Asset List (e.g. index.html sometimes)
    const existingPaths = new Set(allAssets.map(a => a.path ? a.path.replace(/^\//, '') : ''));
    Object.entries(revisionFiles).forEach(([key, val]) => {
        const cleanKey = key.replace(/^\//, '');
        if (!existingPaths.has(cleanKey)) {
            console.log(`[WebSimAPI] Injecting missing asset from revision: ${cleanKey}`);
            allAssets.push({
                path: cleanKey,
                ...val,
                url: val.url || val.src || val.download_url
            });
            existingPaths.add(cleanKey);
        }
    });

    console.log(`[WebSimAPI] Total assets (after enrichment): ${allAssets.length}`);
    return allAssets;
}

export async function getAssetContent(projectId, version, path) {
    const ab = await fetchRaw(`/projects/${projectId}/revisions/${version}/assets/${encodeURIComponent(path)}/content`);
    try {
        const text = new TextDecoder().decode(ab);
        if (text.trim().startsWith('{')) {
            const json = JSON.parse(text);
            const content = json.content || json.data;
            if (content && typeof content === 'string') {
                return new TextEncoder().encode(content).buffer;
            }
        }
    } catch(e) {}
    return ab;
}

export function searchAssets(query, mimeTypePrefix, limit = 20) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (mimeTypePrefix) params.set('mime_type_prefix', mimeTypePrefix);
    if (limit) params.set('limit', limit);
    return makeRequest(`/search/assets?${params.toString()}`);
}

export function searchRelevantAssets(query, limit = 20) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (limit) params.set('limit', limit);
    return makeRequest(`/search/assets/relevant?${params.toString()}`);
}

export async function getProjectHtml(projectId, version) {
    // 1. Priority: Fetch Revision Data (Metadata + potential content)
    // This is more reliable as the dedicated /html endpoint often returns 403
    try {
        console.log(`[API] Fetching revision metadata for HTML...`);
        const response = await fetch(`${API_BASE}/projects/${projectId}/revisions/${version}`);
        if (response.ok) {
            const data = await response.json();
            const rev = data.revision || data; // Handle nested or flat return
            
            // Check common fields where HTML content might be stored
            if (rev.html) return rev.html;
            if (rev.content && typeof rev.content === 'string') return rev.content;
            if (rev.content && rev.content.html) return rev.content.html;
            // Extra fallback fields for various API versions
            if (rev.source) return rev.source;
            if (rev.code) return rev.code;
            if (rev.files && rev.files['index.html']) {
                 const f = rev.files['index.html'];
                 return typeof f === 'string' ? f : f.content;
            }
        }
    } catch (e) {
        console.warn("[API] Revision metadata fetch error:", e);
    }

    // 2. Fallback: Dedicated HTML Endpoint
    try {
        console.log(`[API] Attempting fallback to direct HTML endpoint...`);
        // Remove Content-Type header to avoid 403 on some endpoints
        const response = await fetch(`${API_BASE}/projects/${projectId}/revisions/${version}/html`);
        
        if (response.ok) {
            const text = await response.text();
            if (text.trim().startsWith('{')) {
                try {
                    const json = JSON.parse(text);
                    if (json.content) return json.content;
                    if (json.html) return json.html;
                } catch(e) {
                    console.warn("[API] Failed to parse JSON response for HTML:", e);
                    // If it looks like JSON but failed to parse, it's likely corrupt metadata, NOT valid HTML.
                    // Return null to trigger fallback reconstruction rather than returning raw JSON string.
                    return null;
                }
                // If it parses as JSON but lacks content/html keys, it's not the HTML we want.
                return null; 
            }
            return text;
        }
        console.warn(`[API] Direct HTML fetch failed (${response.status}).`);
    } catch (e) {
        console.warn("[API] HTML fetch error:", e);
    }

    return null;
}

export function parseProjectIdentifier(input) {
    if (!input) return null;
    
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        const pathname = url.pathname;

        const projectMatch = pathname.match(/^\/p\/([a-z0-9_-]{20})/);
        if (projectMatch) return { type: 'id', value: projectMatch[1] };

        const slugMatch = pathname.match(/^\/(@[^/]+)\/([^/]+)/);
        if (slugMatch) return { type: 'slug', username: slugMatch[1].substring(1), slug: slugMatch[2] };
        
        const cMatch = pathname.match(/^\/c\/([a-z0-9_-]{20})/);
        if (cMatch) return { type: 'id', value: cMatch[1] };

    } catch (e) { /* Not a URL */ }

    const atSlugMatch = input.match(/^@([^/]+)\/([^/]+)/);
    if (atSlugMatch) return { type: 'slug', username: atSlugMatch[1], slug: atSlugMatch[2] };

    const slugMatch = input.match(/^([a-zA-Z0-9_]{3,32})\/([a-zA-Z0-9-]{3,50})$/);
    if (slugMatch) return { type: 'slug', username: slugMatch[1], slug: slugMatch[2] };

    if (/^[a-z0-9_-]{20}$/.test(input)) return { type: 'id', value: input };

    throw new Error(`Invalid project identifier: "${input}".`);
}

export async function fetchProjectMetadata(identifier) {
    if (identifier.type === 'id') {
        return getProjectById(identifier.value);
    } else {
        return getProjectBySlug(identifier.username, identifier.slug);
    }
}

// Minimal 1x1 Transparent PNG
const EMPTY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

// Minimal Silence WAV (44 bytes)
const EMPTY_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00
]);

// Helper: Process array in chunks to avoid rate limiting
async function mapLimit(items, limit, fn) {
    const results = [];
    const chunks = [];
    for (let i = 0; i < items.length; i += limit) {
        chunks.push(items.slice(i, i + limit));
    }
    for (const chunk of chunks) {
        const chunkResults = await Promise.all(chunk.map(fn));
        results.push(...chunkResults);
    }
    return results;
}

export async function processAssets(assetList, projectId, version) {
    console.log(`[WebSimAPI] processAssets: Processing ${assetList?.length || 0} items`);
    const files = {};
    const encoder = new TextEncoder();

    if (!assetList || !Array.isArray(assetList)) {
        console.warn("[WebSimAPI] Invalid assetList provided to processAssets");
        return files;
    }

    const processItem = async (asset) => {
        if (!asset.path) return;
        
        const path = asset.path.replace(/^(\.|\/)+/, ''); // Clean path
        if (path.endsWith('/')) return; // Skip explicitly marked directories

        // 1. Embedded Content (String/JSON)
        if (typeof asset.content === 'string' && asset.content.length > 0) {
            files[path] = encoder.encode(asset.content);
            return;
        }
        if (asset.content && typeof asset.content === 'object') {
            files[path] = encoder.encode(JSON.stringify(asset.content));
            return;
        }

        const isText = /\.(html|js|mjs|jsx|ts|tsx|css|json|txt|md|xml|svg|csv)$/i.test(path);
        
        // 2. Identify URL & Metadata Recovery
        // Sometimes the asset list is sparse, so we check various keys or fetch detailed metadata
        let url = asset.url || asset.src || asset.uri || asset.download_url;
        
        if (!url && !isText) {
             console.log(`[WebSimAPI] ${path} -> Missing URL, fetching metadata...`);
             try {
                 const meta = await getAssetMetadata(projectId, version, path);
                 if (meta) {
                     url = meta.url || meta.src || meta.download_url;
                     if (url) {
                         console.log(`[WebSimAPI] ${path} -> Recovered URL: ${url}`);
                     } else {
                         console.warn(`[WebSimAPI] ${path} -> Metadata retrieved but no URL found.`);
                     }
                 }
             } catch(e) {
                 console.warn(`[WebSimAPI] ${path} -> Metadata fetch failed (${e.message}). Skipping.`);
             }
        }

        const isAbsolute = url && url.startsWith('http');
        
        // Helper to fetch via API Content
        const tryFetchContent = async () => {
             if (!projectId || !version) return null;
             try {
                 const ab = await getAssetContent(projectId, version, path);
                 if (ab && ab.byteLength > 0) return new Uint8Array(ab);
             } catch(e) { 
                 console.warn(`[WebSimAPI] ${path} -> API content fetch error:`, e.message);
             }
             return null;
        };

        // Strategy A: API Content (Text Files)
        // We prefer API content for text as it's often more up-to-date or cleaner than CDN
        if (isText) {
            const content = await tryFetchContent();
            if (content) {
                files[path] = content;
                return;
            }
        }

        // Strategy B: CDN URL (Binary / Absolute)
        if (isAbsolute) {
            try {
                // Jitter to avoid rate limits
                await new Promise(r => setTimeout(r, Math.random() * 50));
                
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                
                const blob = await res.arrayBuffer();

                // Validate content
                if (/\.(mp3|wav|ogg|glb|gltf|png|jpg|jpeg|gif)$/i.test(path)) {
                    const contentType = res.headers.get('content-type');
                    // Sanity check: don't save HTML error pages as MP3s
                    if (contentType && (contentType.includes('text/html') || contentType.includes('application/json'))) {
                         throw new Error(`Invalid content-type: ${contentType}`);
                    }
                    if (blob.byteLength > 0) {
                        const header = new Uint8Array(blob.slice(0, 100));
                        const textHeader = new TextDecoder().decode(header).trim().toLowerCase();
                        if (textHeader.startsWith('<!doctype') || textHeader.startsWith('<html')) {
                             throw new Error(`Content sniffer detected HTML signature in binary file`);
                        }
                    }
                }
                
                console.log(`[WebSimAPI] ${path} -> CDN fetch success (${blob.byteLength} bytes)`);
                files[path] = new Uint8Array(blob);
                return;

            } catch(e) {
                console.warn(`[WebSimAPI] ${path} -> CDN load failed: ${e.message}`);
                // Proceed to fallback
            }
        }

        // Strategy C: API Content Fallback (Binary)
        // If CDN failed or was missing, try the /content endpoint (note: often fails 400 for binary)
        if (!files[path] && !isText) {
             console.log(`[WebSimAPI] ${path} -> Attempting API Content Fallback...`);
             const content = await tryFetchContent();
             if (content) {
                 files[path] = content;
                 console.log(`[WebSimAPI] ${path} -> API Content Fallback Success`);
                 return;
             }
        }

        // 4. Default Fail-safes (Empty Placeholders)
        if (isText) {
             console.warn(`[WebSimAPI] ${path} -> FAILED ALL STRATEGIES. Creating placeholder.`);
             files[path] = encoder.encode(`// Missing file: ${path}\n// Failed to download from WebSim.`);
        }

        // 4. Default Fail-safes
        if (/\.(mp3|wav|ogg)$/i.test(path)) {
            files[path] = EMPTY_WAV;
        } else if (/\.(png|jpg|jpeg|gif)$/i.test(path)) {
            files[path] = EMPTY_PNG;
        } else if (isText) {
             // If we failed to get text content, do NOT create an empty file, 
             // because an empty JS file might break imports. 
             // Better to let it be missing so the bundler warns or we handle it elsewhere.
             // BUT, if it's index.html, we might want to handle it.
             if (path === 'index.html') {
                 console.error("Critical: Failed to fetch index.html");
             }
        }
    };

    // Limit concurrency
    await mapLimit(assetList, 5, processItem);
    return files;
}

