(function () {
    const SOURCE_PROFILES = {
        nasa: {
            family: 'agency',
            preset: 'agency-technical',
            label: 'NASA',
            sourceUrl: 'https://www.nasa.gov/',
            palette: ['#0b3d91', '#fc3d21', '#ffffff'],
            displayFont: 'Inter, sans-serif',
            ctaAccent: '#fc3d21',
            secondaryAccent: '#0b3d91',
        },
        esa: {
            family: 'agency',
            preset: 'agency-technical',
            label: 'ESA',
            sourceUrl: 'https://www.esa.int/',
            palette: ['#003087', '#00a0df', '#ffffff'],
            displayFont: 'Inter, sans-serif',
            ctaAccent: '#00a0df',
            secondaryAccent: '#003087',
        },
        jaxa: {
            family: 'agency',
            preset: 'agency-minimal',
            label: 'JAXA',
            sourceUrl: 'https://global.jaxa.jp/',
            palette: ['#111827', '#e60012', '#5b6b86'],
            displayFont: 'Inter, sans-serif',
            ctaAccent: '#e60012',
            secondaryAccent: '#5b6b86',
        },
        isro: {
            family: 'agency',
            preset: 'agency-minimal',
            label: 'ISRO',
            sourceUrl: 'https://www.isro.gov.in/',
            palette: ['#00308f', '#ff9933', '#ffffff'],
            displayFont: 'Inter, sans-serif',
            ctaAccent: '#ff9933',
            secondaryAccent: '#00308f',
        },
        'tech-premium': {
            family: 'tech',
            preset: 'tech-premium',
            label: 'Tech Premium',
            sourceUrl: 'https://vercel.com/',
            palette: ['#050505', '#6ae3ff', '#ccff00'],
            displayFont: 'Space Grotesk, sans-serif',
            ctaAccent: '#6ae3ff',
            secondaryAccent: '#ccff00',
        },
        'tech-editorial': {
            family: 'tech',
            preset: 'tech-editorial',
            label: 'Tech Editorial',
            sourceUrl: 'https://stripe.com/',
            palette: ['#0a0a0a', '#d5d9e0', '#8bb8ff'],
            displayFont: 'Space Grotesk, sans-serif',
            ctaAccent: '#8bb8ff',
            secondaryAccent: '#d5d9e0',
        },
    };

    const PRESET_LIBRARY = {
        'agency-minimal': {
            family: 'agency',
            accent: '#ff9933',
            accentStrong: '#fc3d21',
            panel: 'rgba(8, 11, 18, 0.88)',
            border: 'rgba(190, 208, 255, 0.12)',
            text: '#f4f7f0',
            muted: 'rgba(233, 237, 245, 0.72)',
            deckBg: 'radial-gradient(circle at top, rgba(11, 61, 145, 0.18), transparent 30%), linear-gradient(180deg, #04070d 0%, #000000 100%)',
            displayFont: 'Inter, sans-serif',
            slidePadX: 'clamp(1.35rem, 4vw, 3.9rem)',
            slidePadY: 'clamp(1.2rem, 3vw, 2.3rem)',
        },
        'agency-technical': {
            family: 'agency',
            accent: '#2f6bff',
            accentStrong: '#fc3d21',
            panel: 'rgba(5, 10, 20, 0.86)',
            border: 'rgba(190, 208, 255, 0.12)',
            text: '#f4f7f0',
            muted: 'rgba(229, 236, 247, 0.72)',
            deckBg: 'radial-gradient(circle at top, rgba(47, 107, 255, 0.18), transparent 30%), linear-gradient(180deg, #04070d 0%, #000000 100%)',
            displayFont: 'Inter, sans-serif',
            slidePadX: 'clamp(1.35rem, 4vw, 3.9rem)',
            slidePadY: 'clamp(1.2rem, 3vw, 2.3rem)',
        },
        'tech-premium': {
            family: 'tech',
            accent: '#6ae3ff',
            accentStrong: '#ccff00',
            panel: 'rgba(8, 9, 12, 0.84)',
            border: 'rgba(255, 255, 255, 0.10)',
            text: '#f4f7f0',
            muted: 'rgba(225, 229, 240, 0.70)',
            deckBg: 'radial-gradient(circle at top, rgba(106, 227, 255, 0.14), transparent 30%), linear-gradient(180deg, #050505 0%, #000000 100%)',
            displayFont: 'Space Grotesk, sans-serif',
            slidePadX: 'clamp(1.1rem, 3.4vw, 3.35rem)',
            slidePadY: 'clamp(1.05rem, 2.7vw, 2.05rem)',
        },
        'tech-editorial': {
            family: 'tech',
            accent: '#8bb8ff',
            accentStrong: '#d5d9e0',
            panel: 'rgba(10, 11, 14, 0.88)',
            border: 'rgba(255, 255, 255, 0.10)',
            text: '#f4f7f0',
            muted: 'rgba(217, 221, 228, 0.68)',
            deckBg: 'radial-gradient(circle at top, rgba(139, 184, 255, 0.12), transparent 30%), linear-gradient(180deg, #050505 0%, #000000 100%)',
            displayFont: 'Space Grotesk, sans-serif',
            slidePadX: 'clamp(1.1rem, 3.4vw, 3.35rem)',
            slidePadY: 'clamp(1.05rem, 2.7vw, 2.05rem)',
        },
    };

    const toHex = (n) => n.toString(16).padStart(2, '0');

    function normalizeHex(input) {
        if (!input) return '#000000';
        const value = String(input).trim().replace(/^#/, '');
        if (value.length === 3) {
            return `#${value.split('').map((c) => c + c).join('')}`.toLowerCase();
        }
        if (value.length === 6) return `#${value.toLowerCase()}`;
        return '#000000';
    }

    function hexToRgb(hex) {
        const normalized = normalizeHex(hex).slice(1);
        return {
            r: parseInt(normalized.slice(0, 2), 16),
            g: parseInt(normalized.slice(2, 4), 16),
            b: parseInt(normalized.slice(4, 6), 16),
        };
    }

    function rgbToHex({ r, g, b }) {
        return `#${toHex(Math.max(0, Math.min(255, Math.round(r))))}${toHex(Math.max(0, Math.min(255, Math.round(g))))}${toHex(Math.max(0, Math.min(255, Math.round(b))))}`;
    }

    function mix(hexA, hexB, amount = 0.5) {
        const a = hexToRgb(hexA);
        const b = hexToRgb(hexB);
        return rgbToHex({
            r: a.r + (b.r - a.r) * amount,
            g: a.g + (b.g - a.g) * amount,
            b: a.b + (b.b - a.b) * amount,
        });
    }

    function luminance(hex) {
        const { r, g, b } = hexToRgb(hex);
        const srgb = [r, g, b].map((v) => {
            const channel = v / 255;
            return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return srgb[0] * 0.2126 + srgb[1] * 0.7152 + srgb[2] * 0.0722;
    }

    function saturation(hex) {
        const { r, g, b } = hexToRgb(hex);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        return max === 0 ? 0 : (max - min) / max;
    }

    function hue(hex) {
        const { r, g, b } = hexToRgb(hex);
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        if (delta === 0) return 0;
        let h;
        if (max === rn) h = ((gn - bn) / delta) % 6;
        else if (max === gn) h = (bn - rn) / delta + 2;
        else h = (rn - gn) / delta + 4;
        return Math.round(h * 60 + 360) % 360;
    }

    function contrastText(hex) {
        return luminance(hex) > 0.45 ? '#050505' : '#f4f7f0';
    }

    function logoToneFromPalette(palette) {
        if (!palette.length) {
            return {
                luminance: 0.5,
                saturation: 0.1,
                dominant: '#9aa3b2',
            };
        }

        const weights = palette.map((hex, index) => 1 / (index + 1));
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const blended = palette.reduce((acc, hex, index) => {
            const weight = weights[index] / total;
            const rgb = hexToRgb(hex);
            acc.r += rgb.r * weight;
            acc.g += rgb.g * weight;
            acc.b += rgb.b * weight;
            return acc;
        }, { r: 0, g: 0, b: 0 });
        const dominant = palette[0];
        return {
            luminance: luminance(rgbToHex(blended)),
            saturation: saturation(dominant),
            dominant,
        };
    }

    function getLogoFrameStyle(tone, tokens) {
        const isLightLogo = tone.luminance > 0.62;
        const isDarkLogo = tone.luminance < 0.42;
        const neutralSurface = isLightLogo
            ? 'rgba(9, 11, 16, 0.94)'
            : isDarkLogo
                ? 'rgba(244, 246, 250, 0.98)'
                : 'rgba(218, 223, 230, 0.96)';
        const neutralBorder = isLightLogo
            ? 'rgba(255, 255, 255, 0.10)'
            : 'rgba(10, 12, 18, 0.12)';
        const logoShadow = isLightLogo
            ? '0 20px 35px rgba(0, 0, 0, 0.42)'
            : '0 18px 30px rgba(0, 0, 0, 0.18)';
        return {
            background: neutralSurface,
            borderColor: neutralBorder,
            boxShadow: `${logoShadow}, 0 0 0 1px ${tokens.accent}20`,
            imageFilter: isLightLogo
                ? 'drop-shadow(0 1px 2px rgba(255,255,255,0.06)) brightness(1.02)'
                : 'drop-shadow(0 1px 2px rgba(0,0,0,0.16))',
            textColor: isLightLogo ? '#f4f7f0' : '#050505',
            tone: isLightLogo ? 'dark' : isDarkLogo ? 'light' : 'neutral',
        };
    }

    function applyUniformLogoSizing(logoNodes) {
        logoNodes.forEach((img) => {
            const frame = img.closest('.partner-logo-box, .media-frame, .logo-frame, .brand-logo-frame');
            const ratio = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
            let width = '90%';
            let height = '90%';
            let padding = '0.55rem';

            if (ratio > 2.6) {
                width = '96%';
                height = '72%';
                padding = '0.4rem';
            } else if (ratio > 1.4) {
                width = '94%';
                height = '80%';
                padding = '0.45rem';
            } else if (ratio < 0.85) {
                width = '74%';
                height = '94%';
                padding = '0.7rem';
            }

            img.style.width = width;
            img.style.height = height;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '100%';
            img.style.margin = '0 auto';
            img.style.display = 'block';
            img.style.objectFit = 'contain';
            img.style.objectPosition = 'center';

            if (frame) {
                frame.style.padding = padding;
            }
        });
    }

    function waitForImageLoad(img) {
        return new Promise((resolve) => {
            if (!img) {
                resolve();
                return;
            }
            if (img.complete && img.naturalWidth > 0) {
                resolve();
                return;
            }
            const finish = () => resolve();
            img.addEventListener('load', finish, { once: true });
            img.addEventListener('error', finish, { once: true });
        });
    }

    async function cleanLogoBackground(img) {
        if (!img || img.dataset.logoBackgroundCleaned === 'true') return null;
        if (img.closest('#reference-panel')) return null;

        const source = img.currentSrc || img.src;
        if (!source || /^https?:\/\//i.test(source) && !source.includes(window.location.hostname)) {
            return null;
        }

        return new Promise((resolve) => {
            const probe = new Image();
            probe.onload = () => {
                try {
                    const width = probe.naturalWidth || probe.width || 512;
                    const height = probe.naturalHeight || probe.height || 512;
                    const maxDim = 384;
                    const scale = Math.min(1, maxDim / Math.max(width, height));
                    const outW = Math.max(1, Math.round(width * scale));
                    const outH = Math.max(1, Math.round(height * scale));
                    const canvas = document.createElement('canvas');
                    canvas.width = outW;
                    canvas.height = outH;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(probe, 0, 0, outW, outH);
                    const imageData = ctx.getImageData(0, 0, outW, outH);
                    const data = imageData.data;

                    let edgeR = 255;
                    let edgeG = 255;
                    let edgeB = 255;
                    let edgeCount = 0;
                    const takeEdge = (x, y) => {
                        const idx = (y * outW + x) * 4;
                        edgeR += data[idx];
                        edgeG += data[idx + 1];
                        edgeB += data[idx + 2];
                        edgeCount++;
                    };

                    for (let x = 0; x < outW; x++) {
                        takeEdge(x, 0);
                        takeEdge(x, outH - 1);
                    }
                    for (let y = 1; y < outH - 1; y++) {
                        takeEdge(0, y);
                        takeEdge(outW - 1, y);
                    }

                    edgeR /= edgeCount;
                    edgeG /= edgeCount;
                    edgeB /= edgeCount;
                    const edgeLuma = (edgeR + edgeG + edgeB) / 3;
                    const edgeSpread = Math.max(edgeR, edgeG, edgeB) - Math.min(edgeR, edgeG, edgeB);

                    for (let i = 0; i < data.length; i += 4) {
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];
                        const a = data[i + 3];
                        if (a === 0) continue;
                        const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
                        const sat = saturation(rgbToHex({ r, g, b }));
                        const closeToLightBg = edgeLuma > 225 && luma > 0.9 && sat < 0.18;
                        const closeToDarkBg = edgeLuma < 60 && luma < 0.16 && sat < 0.2;
                        const closeToEdgeBg = edgeSpread < 24 && Math.abs(r - edgeR) < 20 && Math.abs(g - edgeG) < 20 && Math.abs(b - edgeB) < 20;
                        if (closeToLightBg || closeToDarkBg || closeToEdgeBg) {
                            data[i + 3] = 0;
                        }
                    }

                    ctx.putImageData(imageData, 0, 0);
                    const cleaned = canvas.toDataURL('image/png');
                    img.dataset.logoBackgroundCleaned = 'true';
                    img.style.background = 'transparent';
                    resolve(cleaned);
                } catch (error) {
                    resolve(null);
                }
            };
            probe.onerror = () => resolve(null);
            probe.crossOrigin = 'anonymous';
            probe.src = source;
        });
    }

    function inferSourceId(text) {
        const value = String(text || '').toLowerCase();
        if (value.includes('nasa')) return 'nasa';
        if (value.includes('esa')) return 'esa';
        if (value.includes('jaxa')) return 'jaxa';
        if (value.includes('isro')) return 'isro';
        if (value.includes('vercel') || value.includes('stripe') || value.includes('github') || value.includes('openai')) {
            return 'tech-premium';
        }
        return null;
    }

    function detectPresetId(mode, samples) {
        const palette = samples.length ? samples : [];
        const top = palette[0] || '#0b3d91';
        const topHue = hue(top);
        const topSat = saturation(top);
        const topLum = luminance(top);

        if (mode === 'agency') {
            if (topHue >= 330 || topHue <= 25) return 'agency-minimal';
            if (topHue >= 160 && topHue <= 230) return 'agency-technical';
            return topSat > 0.45 && topLum < 0.55 ? 'agency-technical' : 'agency-minimal';
        }

        if (topSat > 0.42 && topHue >= 160 && topHue <= 220) return 'tech-premium';
        return topLum > 0.55 ? 'tech-editorial' : 'tech-premium';
    }

    async function formatLogoFrames(logoNodes, tokens) {
        const tasks = logoNodes.map(async (img) => {
            const cleaned = await cleanLogoBackground(img);
            if (cleaned) {
                img.src = cleaned;
                await waitForImageLoad(img);
            }
            const palette = await imagePaletteFromSrc(img.currentSrc || img.src);
            const tone = logoToneFromPalette(palette);
            const frame = img.closest('.partner-logo-box, .media-frame, .logo-frame, .brand-logo-frame');
            const ratio = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
            const pad = ratio > 2.2 ? '0.35rem' : ratio < 0.9 ? '0.65rem' : '0.5rem';

            if (frame) {
                const frameStyle = getLogoFrameStyle(tone, tokens);
                frame.dataset.logoTone = frameStyle.tone;
                frame.style.background = frameStyle.background;
                frame.style.borderColor = frameStyle.borderColor;
                frame.style.boxShadow = frameStyle.boxShadow;
                frame.style.padding = pad;
                frame.style.setProperty('--logo-surface', frameStyle.background);
                frame.style.setProperty('--logo-text', frameStyle.textColor);
                frame.classList.add('logo-frame');
            }

            img.style.filter = getLogoFrameStyle(tone, tokens).imageFilter;
            img.style.mixBlendMode = tone.luminance > 0.62 ? 'screen' : 'normal';
        });

        await Promise.all(tasks);
        applyUniformLogoSizing(logoNodes);
    }

    function stageReferenceLinks(entries) {
        if (!Array.isArray(entries)) return [];
        const seen = new Set();
        return entries
            .map((entry) => {
                if (!entry) return null;
                if (typeof entry === 'string') {
                    return { label: entry, url: entry };
                }
                const url = entry.url || entry.href || '';
                if (!url) return null;
                return {
                    label: entry.label || entry.title || url,
                    url,
                };
            })
            .filter(Boolean)
            .filter((entry) => {
                const key = `${entry.label}::${entry.url}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    function normalizeUrl(input) {
        if (!input) return '';
        try {
            const parsed = new URL(String(input).trim());
            parsed.hash = '';
            if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
                parsed.pathname = parsed.pathname.replace(/\/+$/, '');
            }
            parsed.host = parsed.host.toLowerCase();
            parsed.protocol = parsed.protocol.toLowerCase();
            return parsed.toString();
        } catch (error) {
            return String(input).trim();
        }
    }

    function validateLumaUrl(url) {
        const normalized = normalizeUrl(url);
        const report = {
            ok: false,
            normalizedUrl: normalized,
            host: '',
            path: '',
            checks: [],
            warnings: [],
            notes: [],
        };

        if (!normalized) {
            report.checks.push({ ok: false, label: 'Luma URL is set' });
            report.notes.push('Add a valid Luma URL to deckConfig.lumaUrl.');
            return report;
        }

        let parsed = null;
        try {
            parsed = new URL(normalized);
        } catch (error) {
            report.checks.push({ ok: false, label: 'URL parses correctly' });
            report.notes.push('The configured URL is not a valid absolute URL.');
            return report;
        }

        report.host = parsed.host;
        report.path = parsed.pathname;

        const hostOk = /(^|\.)luma\.com$/i.test(parsed.host) || /(^|\.)lu\.ma$/i.test(parsed.host);
        report.checks.push({ ok: hostOk, label: 'Hosted on Luma' });
        if (!hostOk) {
            report.warnings.push('This deck expects a Luma host, but the configured URL points elsewhere.');
        }

        const schemeOk = parsed.protocol === 'https:';
        report.checks.push({ ok: schemeOk, label: 'Uses HTTPS' });
        if (!schemeOk) {
            report.warnings.push('Use https:// for the event link so QR scanners and backlinks stay consistent.');
        }

        const hasEventPath = /\/event\/(manage\/)?evt-[^/]+/i.test(parsed.pathname) || /\/r\/[^/]+/i.test(parsed.pathname) || parsed.pathname.length > 1;
        report.checks.push({ ok: hasEventPath, label: 'Looks like an event page' });

        const manageView = /\/event\/manage\/evt-[^/]+\/overview/i.test(parsed.pathname);
        if (manageView) {
            report.notes.push('This is a manage/overview link, so the flow can validate structure and consistency, but not fetch private dashboard content.');
        }

        report.ok = report.checks.every((check) => check.ok);
        return report;
    }

    function validateDeckLumaConsistency(deckConfig) {
        const normalizedUrl = normalizeUrl(deckConfig.lumaUrl);
        const references = stageReferenceLinks(deckConfig.references);
        const exactRefs = references.filter((ref) => normalizeUrl(ref.url) === normalizedUrl);
        const lumaAnchors = Array.from(document.querySelectorAll('#luma-qr-link, #luma-qr-signup-link'));
        const anchorMatches = lumaAnchors.every((anchor) => normalizeUrl(anchor.href) === normalizedUrl);
        const referenceMatch = exactRefs.length > 0;
        const urlReport = validateLumaUrl(normalizedUrl);
        const panelExists = Boolean(document.getElementById('reference-panel'));
        const qrTargetsPresent = lumaAnchors.length === 2;

        const checks = [
            { ok: Boolean(normalizedUrl), label: 'Deck has a Luma URL' },
            { ok: urlReport.ok, label: 'Luma URL shape is valid' },
            { ok: referenceMatch, label: 'References include the same URL' },
            { ok: anchorMatches, label: 'QR links target the same URL' },
            { ok: panelExists, label: 'Reference panel is available' },
            { ok: qrTargetsPresent, label: 'Both QR anchors are present' },
        ];

        const warnings = [...urlReport.warnings];
        if (!referenceMatch) warnings.push('The reference list should include the exact Luma URL to keep backlinks aligned.');
        if (!anchorMatches) warnings.push('At least one QR anchor does not match deckConfig.lumaUrl.');
        if (!qrTargetsPresent) warnings.push('One or both QR anchors were not found in the DOM.');

        return {
            ok: checks.every((check) => check.ok),
            normalizedUrl,
            checks,
            warnings,
            notes: urlReport.notes,
            urlReport,
            references,
        };
    }

    function renderLumaValidation(report) {
        const root = document.getElementById('luma-validation');
        if (!root) return;

        const tone = report.ok ? 'rgba(34,197,94,0.16)' : 'rgba(255,77,0,0.14)';
        const border = report.ok ? 'rgba(34,197,94,0.28)' : 'rgba(255,77,0,0.28)';
        const label = report.ok ? 'Luma link verified' : 'Luma link needs review';
        const statusChip = report.ok ? 'PASS' : 'CHECK';

        root.classList.remove('hidden');
        root.innerHTML = `
            <div class="rounded-2xl border px-3 py-2 space-y-1.5" style="background:${tone}; border-color:${border};">
                <div class="flex items-center justify-between gap-4">
                    <div>
                        <div class="text-[9px] uppercase tracking-[0.3em] font-mono text-stone-300">Validation Flow</div>
                        <h4 class="text-[12px] font-bold text-white mt-1">${label}</h4>
                    </div>
                    <span class="text-[9px] font-mono uppercase tracking-[0.28em] px-2.5 py-1 rounded-full border" style="border-color:${border}; color:${report.ok ? '#ccff00' : '#ffb199'}">${statusChip}</span>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1">
                    ${report.checks.slice(0, 4).map((check) => `
                        <div class="flex items-start gap-2 text-[10px] ${check.ok ? 'text-stone-200' : 'text-stone-400'}">
                            <span class="mt-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border text-[8px] font-bold ${check.ok ? 'border-emerald-400 text-emerald-400' : 'border-orange-300 text-orange-300'}">${check.ok ? '✓' : '!'}</span>
                            <span class="leading-snug">${check.label}</span>
                        </div>
                    `).join('')}
                </div>
                <div class="flex flex-wrap items-center gap-2 pt-0.5">
                    <span class="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full border border-white/10 text-stone-300">URL ${report.normalizedUrl || 'missing'}</span>
                    <span class="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full border border-white/10 text-stone-300">Refs ${report.references.length}</span>
                    ${report.warnings.length ? `<span class="text-[9px] font-mono uppercase tracking-widest px-2.5 py-1 rounded-full border border-orange-300/30 text-orange-200">Check ${report.warnings.length}</span>` : ''}
                </div>
                ${report.notes.length ? `<p class="text-[9px] text-stone-300 leading-snug">${report.notes[0]}</p>` : ''}
            </div>
        `;
    }

    function runDeckQA(deckConfig, context = {}) {
        const slides = Array.from(document.querySelectorAll('.slide'));
        const activeSlide = document.querySelector('.slide.active');
        const slideCount = slides.length;
        const currentSlide = Number(context.currentSlide || 0);
        const qrLink = document.getElementById('luma-qr-link');
        const qrLinkAlt = document.getElementById('luma-qr-signup-link');
        const qaBadge = document.getElementById('deck-qa-badge');
        const logoNodes = activeSlide
            ? Array.from(activeSlide.querySelectorAll('[data-brand-sample="true"]'))
            : [];

        const normalizedUrl = normalizeUrl(deckConfig.lumaUrl);
        const references = stageReferenceLinks(deckConfig.references);
        const urlConsistency = validateDeckLumaConsistency(deckConfig);
        const logoReady = logoNodes.length === 0 || logoNodes.every((img) => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
        const activeReady = Boolean(activeSlide);
        const slideCountOk = slideCount === 7;
        const qrOk = Boolean(qrLink) && Boolean(qrLinkAlt);
        const expectedSlide = currentSlide >= 1 && currentSlide <= 7;
        const activeSlideId = activeSlide ? activeSlide.id : '';
        const issues = [];
        const warnings = [];

        if (!slideCountOk) issues.push(`Expected 7 slides, found ${slideCount}.`);
        if (!activeReady) issues.push('No active slide is visible.');
        if (!expectedSlide) issues.push(`Invalid current slide index: ${currentSlide}.`);
        if (!qrOk) issues.push('QR anchors are missing.');
        if (!logoReady) issues.push('At least one branded logo is still loading.');
        if (!deckConfig.lumaUrl) issues.push('Luma URL is missing.');
        if (!urlConsistency.ok) warnings.push('Luma link consistency checks need a review pass.');

        const report = {
            ok: issues.length === 0,
            slideCount,
            activeSlideId,
            currentSlide,
            normalizedUrl,
            referencesCount: references.length,
            issues,
            warnings,
            checks: [
                { ok: slideCountOk, label: '7 slides present' },
                { ok: activeReady, label: 'Active slide visible' },
                { ok: expectedSlide, label: 'Slide index valid' },
                { ok: qrOk, label: 'QR anchors wired' },
                { ok: logoReady, label: 'Logos loaded' },
                { ok: urlConsistency.ok, label: 'Luma consistency passes' },
            ],
            details: urlConsistency,
        };

        if (qaBadge) {
            qaBadge.textContent = report.ok
                ? `AUTO QA PASS • STAGE ${currentSlide || '?'}`
                : `AUTO QA CHECK • ${issues.length} ISSUE${issues.length === 1 ? '' : 'S'}`;
            qaBadge.dataset.state = report.ok ? 'pass' : 'warn';
            qaBadge.dataset.slide = activeSlideId || '';
            qaBadge.classList.toggle('text-emerald-300', report.ok);
            qaBadge.classList.toggle('text-orange-200', !report.ok);
            qaBadge.classList.toggle('border-emerald-400/25', report.ok);
            qaBadge.classList.toggle('border-orange-300/25', !report.ok);
            qaBadge.classList.toggle('bg-emerald-400/10', report.ok);
            qaBadge.classList.toggle('bg-orange-400/10', !report.ok);
        }

        console.info('[Deck QA]', report);
        return report;
    }

    function normalizePalette(samples, mode, sourceId) {
        const sourceProfile = SOURCE_PROFILES[sourceId] || null;
        const presetId = (sourceProfile && sourceProfile.preset) || detectPresetId(mode, samples);
        const preset = PRESET_LIBRARY[presetId] || PRESET_LIBRARY[mode === 'tech' ? 'tech-premium' : 'agency-technical'];
        const sourcePalette = (sourceProfile && sourceProfile.palette) || [];
        const merged = [...samples, ...sourcePalette].filter(Boolean).map(normalizeHex);
        const dominant = merged[0] || preset.accent;
        const secondary = merged.find((color) => color !== dominant) || preset.accentStrong;
        const accent = dominant;
        const accentStrong = mix(secondary, preset.accentStrong, 0.4);
        const text = preset.text;
        const muted = preset.muted;
        const panel = preset.panel;
        const border = preset.border;
        const deckBg = preset.deckBg;
        const displayFont = (SOURCE_PROFILES[sourceId] && SOURCE_PROFILES[sourceId].displayFont) || preset.displayFont;

        return {
            sourceId,
            presetId,
            sourceLabel: (sourceProfile && sourceProfile.label) || sourceId,
            family: mode,
            accent,
            accentStrong,
            panel,
            border,
            text,
            muted,
            deckBg,
            displayFont,
            bodyFont: 'Inter, sans-serif',
            monoFont: 'JetBrains Mono, monospace',
            ctaText: contrastText(accent),
            qrcodeDark: contrastText(accent) === '#050505' ? '#050505' : '#0a0a0a',
            qrcodeLight: '#ffffff',
        };
    }

    async function imagePaletteFromSrc(src) {
        return new Promise((resolve) => {
            if (!src) {
                resolve([]);
                return;
            }

            const image = new Image();
            if (/^https?:\/\//i.test(src)) {
                image.crossOrigin = 'anonymous';
            }

            image.onload = () => {
                try {
                    const size = 48;
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.clearRect(0, 0, size, size);
                    ctx.drawImage(image, 0, 0, size, size);
                    const { data } = ctx.getImageData(0, 0, size, size);
                    const buckets = new Map();

                    for (let i = 0; i < data.length; i += 4) {
                        const r = data[i];
                        const g = data[i + 1];
                        const b = data[i + 2];
                        const a = data[i + 3];
                        if (a < 180) continue;
                        const max = Math.max(r, g, b);
                        const min = Math.min(r, g, b);
                        if (max < 18 || min > 245 || max - min < 12) continue;
                        const key = rgbToHex({
                            r: Math.round(r / 16) * 16,
                            g: Math.round(g / 16) * 16,
                            b: Math.round(b / 16) * 16,
                        });
                        buckets.set(key, (buckets.get(key) || 0) + 1);
                    }

                    const result = Array.from(buckets.entries())
                        .sort((a, b) => b[1] - a[1])
                        .map(([color]) => color)
                        .slice(0, 6);
                    resolve(result);
                } catch (error) {
                    resolve([]);
                }
            };

            image.onerror = () => resolve([]);
            image.src = src;
        });
    }

    function setCssVars(tokens) {
        const root = document.documentElement.style;
        root.setProperty('--panel', tokens.panel);
        root.setProperty('--border', tokens.border);
        root.setProperty('--accent', tokens.accent);
        root.setProperty('--accent-strong', tokens.accentStrong);
        root.setProperty('--text', tokens.text);
        root.setProperty('--muted', tokens.muted);
        root.setProperty('--deck-bg', tokens.deckBg);
        root.setProperty('--font-body', tokens.bodyFont);
        root.setProperty('--font-display', tokens.displayFont);
        root.setProperty('--font-mono', tokens.monoFont);
        root.setProperty('--slide-pad-x', tokens.slidePadX || 'clamp(1.3rem, 4vw, 3.6rem)');
        root.setProperty('--slide-pad-y', tokens.slidePadY || 'clamp(1.15rem, 3vw, 2.25rem)');
    }

    function updateAlignmentUI(tokens, deckConfig) {
        const shell = document.getElementById('deck-shell');
        const pill = document.getElementById('alignment-pill');
        const qrUrl = document.getElementById('luma-url');
        const qrLink = document.getElementById('luma-qr-link');
        const qrLinkAlt = document.getElementById('luma-qr-signup-link');
        const referencePanel = document.getElementById('reference-panel');
        const referenceList = document.getElementById('reference-list');
        const validateButton = document.getElementById('luma-validate-button');
        const displayLabel = `${deckConfig.alignmentMode.toUpperCase()} ALIGNMENT`;

        if (shell) {
            shell.dataset.alignment = tokens.family;
        }
        if (pill) {
            pill.textContent = `${displayLabel} • ${tokens.sourceLabel.toUpperCase()} • ${tokens.presetId.replace('-', ' ').toUpperCase()}`;
            pill.style.borderColor = tokens.border;
            pill.style.color = tokens.accent;
        }
        if (qrUrl) {
            qrUrl.textContent = deckConfig.lumaUrl || '';
        }
        if (qrLink) {
            qrLink.href = deckConfig.lumaUrl || '#';
        }
        if (qrLinkAlt) {
            qrLinkAlt.href = deckConfig.lumaUrl || '#';
        }
        if (validateButton) {
            validateButton.dataset.target = deckConfig.lumaUrl || '';
        }
        if (referencePanel && referenceList) {
            referenceList.innerHTML = '';
            const refs = stageReferenceLinks(deckConfig.references);
            if (refs.length > 0) {
                referencePanel.classList.remove('hidden');
                refs.forEach((ref) => {
                    const anchor = document.createElement('a');
                    anchor.href = ref.url;
                    anchor.target = '_blank';
                    anchor.rel = 'noopener noreferrer';
                    anchor.className = 'px-3 py-1.5 rounded-full text-[10px] font-mono uppercase tracking-widest border transition-colors';
                    anchor.style.background = 'rgba(255,255,255,0.05)';
                    anchor.style.borderColor = tokens.border;
                    anchor.style.color = tokens.accent;
                    anchor.textContent = ref.label || ref.url;
                    referenceList.appendChild(anchor);
                });
            } else {
                referencePanel.classList.add('hidden');
            }
        }
    }

    function renderQr(targetId, text, tokens) {
        const target = document.getElementById(targetId);
        if (!target) return;
        target.innerHTML = '';

        const fallback = target.parentElement ? target.parentElement.querySelector('img') : null;
        if (!text || !String(text).trim() || !window.QRCode) {
            if (fallback) {
                fallback.classList.remove('opacity-0', 'pointer-events-none');
            }
            return;
        }

        try {
            const box = Math.max(144, Math.floor(Math.min(target.clientWidth || 180, target.clientHeight || 180)));
            new window.QRCode(target, {
                text,
                width: box,
                height: box,
                colorDark: tokens.qrcodeDark,
                colorLight: tokens.qrcodeLight,
                correctLevel: window.QRCode.CorrectLevel.M,
            });
            if (fallback) {
                fallback.classList.add('opacity-0', 'pointer-events-none');
            }
        } catch (error) {
            if (fallback) {
                fallback.classList.remove('opacity-0', 'pointer-events-none');
            }
        }
    }

    async function applyThemeFromDeck(deckConfig, options = {}) {
        const mode = deckConfig.alignmentMode === 'tech' ? 'tech' : 'agency';
        const logoSelector = options.logoSelector || '.partner-logo-box img';
        const logoNodes = Array.from(document.querySelectorAll(logoSelector));
        const hints = [
            deckConfig.brandHint,
            deckConfig.alignmentMode,
            ...logoNodes.map((img) => `${img.alt || ''} ${img.src || ''}`),
        ];
        const sourceId = hints.map(inferSourceId).find(Boolean) || (mode === 'tech' ? 'tech-premium' : 'agency-technical');

        const sampledColors = [];
        for (const img of logoNodes) {
            const palette = await imagePaletteFromSrc(img.currentSrc || img.src);
            sampledColors.push(...palette);
        }

        const tokens = normalizePalette(sampledColors, mode, sourceId);
        setCssVars(tokens);
        updateAlignmentUI(tokens, deckConfig);

        const validation = validateDeckLumaConsistency(deckConfig);
        renderLumaValidation(validation);

        await formatLogoFrames(logoNodes, tokens);

        const targets = [
            { id: options.qrTargetId, text: deckConfig.lumaUrl },
            { id: options.qrTargetIdAlt, text: deckConfig.lumaUrl },
        ];
        for (const entry of targets) {
            if (entry.id) {
                renderQr(entry.id, entry.text, tokens);
            }
        }

        return tokens;
    }

    window.BrandSystem = {
        sourceProfiles: SOURCE_PROFILES,
        presets: PRESET_LIBRARY,
        applyThemeFromDeck,
        imagePaletteFromSrc,
        inferSourceId,
        normalizePalette,
        stageReferenceLinks,
        normalizeUrl,
        cleanLogoBackground,
        validateLumaUrl,
        validateDeckLumaConsistency,
        renderLumaValidation,
        runDeckQA,
        applyUniformLogoSizing,
    };
})();
