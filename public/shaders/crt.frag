precision mediump float;

varying vec2 vUv;

uniform sampler2D uTexture;
uniform float uTime;
uniform vec2 uResolution;
uniform float uOverlayMode; // 0.0 = boot (sample texture), 1.0 = transparent overlay

// Effect intensities
uniform float uCurvature;       // barrel distortion strength
uniform float uChromatic;       // chromatic aberration px
uniform float uScanlineCount;   // number of scanlines
uniform float uScanlineIntensity;
uniform float uBloomRadius;     // bloom sample offset
uniform float uBloomIntensity;
uniform float uVignetteIntensity;
uniform float uFlickerIntensity;
uniform float uNoiseIntensity;
uniform float uJitterIntensity;
uniform float uJitterChance;    // probability of jitter per frame
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGlowColor;      // 0=green, shifts hue

// --- Barrel Distortion ---
vec2 barrelDistort(vec2 uv, float k) {
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  vec2 distorted = centered * (1.0 + k * r2);
  return distorted + 0.5;
}

// --- Pseudo-random hash ---
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// --- Noise ---
float noise(vec2 uv, float t) {
  vec2 seed = uv * uResolution + vec2(t * 1000.0);
  return hash(seed);
}

void main() {
  vec2 uv = vUv;

  // Horizontal jitter: sparse random line displacement
  float jitterSeed = hash(vec2(floor(uv.y * uResolution.y), floor(uTime * 60.0)));
  if (jitterSeed > (1.0 - uJitterChance)) {
    float jitterOffset = (hash(vec2(uv.y * 100.0, uTime * 37.0)) - 0.5) * 2.0;
    uv.x += jitterOffset * uJitterIntensity * (1.0 / uResolution.x) * 20.0;
  }

  // Apply barrel distortion
  vec2 distUv = barrelDistort(uv, uCurvature);

  // Out-of-bounds check
  if (distUv.x < 0.0 || distUv.x > 1.0 || distUv.y < 0.0 || distUv.y > 1.0) {
    if (uOverlayMode > 0.5) {
      // Transparent overlay: fully transparent out of bounds
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    } else {
      // Boot mode: black border
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    }
    return;
  }

  // ── OVERLAY MODE: effects only, no texture sampling ──
  if (uOverlayMode > 0.5) {
    float alpha = 0.0;

    // Scanlines — darken bands
    float scanline = sin(distUv.y * uScanlineCount * 3.14159265);
    scanline = scanline * scanline;
    alpha += scanline * uScanlineIntensity;

    // Vignette — darken edges
    vec2 vigUv = abs(distUv - 0.5) * 2.0;
    float vig = max(vigUv.x, vigUv.y);
    vig = smoothstep(0.6, 1.0, vig);
    alpha += vig * uVignetteIntensity;

    // Flicker — subtle brightness oscillation
    float flicker = uFlickerIntensity * (
      sin(uTime * 110.0) * 0.4 +
      sin(uTime * 7.3) * 0.35 +
      sin(uTime * 23.7) * 0.25
    );

    // Noise — grain
    float n = noise(distUv, uTime);
    float noiseVal = (n - 0.5) * uNoiseIntensity;

    // Combine: dark overlay with grain/flicker modulation
    alpha = clamp(alpha + flicker, 0.0, 0.6);
    vec3 overlayColor = vec3(noiseVal * 0.5 + 0.02);

    gl_FragColor = vec4(overlayColor, alpha);
    return;
  }

  // ── BOOT MODE: full texture sampling with all effects ──
  // Chromatic Aberration
  vec2 dir = (distUv - 0.5);
  float chromaticOffset = uChromatic / uResolution.x;
  float r = texture2D(uTexture, distUv + dir * chromaticOffset).r;
  float g = texture2D(uTexture, distUv).g;
  float b = texture2D(uTexture, distUv - dir * chromaticOffset).b;
  vec3 color = vec3(r, g, b);

  // Bloom / Phosphor Glow
  vec2 texel = 1.0 / uResolution;
  float bloomOff = uBloomRadius;
  vec3 bloom = vec3(0.0);
  bloom += texture2D(uTexture, distUv).rgb * 0.25;
  bloom += texture2D(uTexture, distUv + vec2( texel.x, 0.0) * bloomOff).rgb * 0.1;
  bloom += texture2D(uTexture, distUv + vec2(-texel.x, 0.0) * bloomOff).rgb * 0.1;
  bloom += texture2D(uTexture, distUv + vec2(0.0,  texel.y) * bloomOff).rgb * 0.1;
  bloom += texture2D(uTexture, distUv + vec2(0.0, -texel.y) * bloomOff).rgb * 0.1;
  bloom += texture2D(uTexture, distUv + vec2( texel.x,  texel.y) * bloomOff).rgb * 0.065;
  bloom += texture2D(uTexture, distUv + vec2(-texel.x,  texel.y) * bloomOff).rgb * 0.065;
  bloom += texture2D(uTexture, distUv + vec2( texel.x, -texel.y) * bloomOff).rgb * 0.065;
  bloom += texture2D(uTexture, distUv + vec2(-texel.x, -texel.y) * bloomOff).rgb * 0.065;
  bloom += texture2D(uTexture, distUv + vec2( texel.x * 2.0, 0.0) * bloomOff).rgb * 0.02;
  bloom += texture2D(uTexture, distUv + vec2(-texel.x * 2.0, 0.0) * bloomOff).rgb * 0.02;
  bloom += texture2D(uTexture, distUv + vec2(0.0,  texel.y * 2.0) * bloomOff).rgb * 0.02;
  bloom += texture2D(uTexture, distUv + vec2(0.0, -texel.y * 2.0) * bloomOff).rgb * 0.02;
  color += bloom * uBloomIntensity;

  // Scanlines
  float scanline = sin(distUv.y * uScanlineCount * 3.14159265);
  scanline = scanline * scanline;
  color *= 1.0 - scanline * uScanlineIntensity;

  // Flicker
  float flicker = 1.0 - uFlickerIntensity * (
    sin(uTime * 110.0) * 0.4 +
    sin(uTime * 7.3) * 0.35 +
    sin(uTime * 23.7) * 0.25
  );
  color *= flicker;

  // Vignette (Chebyshev distance)
  vec2 vigUv = abs(distUv - 0.5) * 2.0;
  float vig = max(vigUv.x, vigUv.y);
  vig = smoothstep(0.6, 1.0, vig);
  color *= 1.0 - vig * uVignetteIntensity;

  // Noise
  float n = noise(distUv, uTime);
  color += (n - 0.5) * uNoiseIntensity;

  // Brightness / Contrast
  color = (color - 0.5) * uContrast + 0.5;
  color += uBrightness;

  // Clamp
  color = clamp(color, 0.0, 1.0);

  gl_FragColor = vec4(color, 1.0);
}
