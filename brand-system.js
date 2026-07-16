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
            let width = '82%';
            let height = '82%';
            let padding = '0.7rem';

            if (ratio > 2.6) {
                width = '90%';
                height = '64%';
                padding = '0.45rem';
            } else if (ratio > 1.4) {
                width = '84%';
                height = '72%';
                padding = '0.55rem';
            } else if (ratio < 0.85) {
                width = '66%';
                height = '88%';
                padding = '0.85rem';
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
            const palette = await imagePaletteFromSrc(img.currentSrc || img.src);
            const tone = logoToneFromPalette(palette);
            const frame = img.closest('.partner-logo-box, .media-frame, .logo-frame, .brand-logo-frame');
            const ratio = (img.naturalWidth && img.naturalHeight) ? img.naturalWidth / img.naturalHeight : 1;
            const pad = ratio > 2.2 ? '0.45rem' : ratio < 0.9 ? '0.9rem' : '0.7rem';

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
        if (referencePanel && referenceList) {
            referenceList.innerHTML = '';
            const refs = Array.isArray(deckConfig.references) ? deckConfig.references : [];
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
    };
})();
