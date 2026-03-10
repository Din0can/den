import { GAME_WIDTH, GAME_HEIGHT, CRT_PARAMS } from './config.js';

let gl, canvas, gameCanvas;
let program, texture, quadBuffer;
const uLocs = {};
let params = { ...CRT_PARAMS };
let lastTime = 0;
let renderCallback = null;

function compileShader(src, type) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(vertSrc, fragSrc) {
  const vert = compileShader(vertSrc, gl.VERTEX_SHADER);
  const frag = compileShader(fragSrc, gl.FRAGMENT_SHADER);
  if (!vert || !frag) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, vert);
  gl.attachShader(prog, frag);
  gl.bindAttribLocation(prog, 0, 'aPosition');
  gl.linkProgram(prog);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  const targetRatio = GAME_WIDTH / GAME_HEIGHT;
  const windowRatio = w / h;
  let canvasW, canvasH;

  if (windowRatio > targetRatio) {
    canvasH = h;
    canvasW = Math.round(h * targetRatio);
  } else {
    canvasW = w;
    canvasH = Math.round(w / targetRatio);
  }

  canvas.width = canvasW * dpr;
  canvas.height = canvasH * dpr;
  canvas.style.width = canvasW + 'px';
  canvas.style.height = canvasH + 'px';
  gl.viewport(0, 0, canvas.width, canvas.height);
}

function frame(now) {
  requestAnimationFrame(frame);

  // Call game render callback
  if (renderCallback) {
    renderCallback(now);
  }

  // Upload game canvas as texture
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, gameCanvas);

  // Set uniforms
  gl.uniform1f(uLocs.uTime, now * 0.001);
  gl.uniform2f(uLocs.uResolution, canvas.width, canvas.height);
  gl.uniform1f(uLocs.uOverlayMode, 0.0);
  gl.uniform1f(uLocs.uCurvature, params.curvature || 0);
  gl.uniform1f(uLocs.uChromatic, params.chromatic || 0);
  gl.uniform1f(uLocs.uScanlineCount, params.scanlineCount || 300);
  gl.uniform1f(uLocs.uScanlineIntensity, params.scanlineIntensity || 0);
  gl.uniform1f(uLocs.uBloomRadius, params.bloomRadius || 3);
  gl.uniform1f(uLocs.uBloomIntensity, params.bloomIntensity || 0);
  gl.uniform1f(uLocs.uVignetteIntensity, params.vignetteIntensity || 0);
  gl.uniform1f(uLocs.uFlickerIntensity, params.flickerIntensity || 0);
  gl.uniform1f(uLocs.uNoiseIntensity, params.noiseIntensity || 0);
  gl.uniform1f(uLocs.uJitterIntensity, params.jitterIntensity || 0);
  gl.uniform1f(uLocs.uJitterChance, params.jitterChance || 0);
  gl.uniform1f(uLocs.uBrightness, params.brightness || 0);
  gl.uniform1f(uLocs.uContrast, params.contrast || 1);
  gl.uniform1f(uLocs.uSaturation, params.saturation || 1);
  gl.uniform1f(uLocs.uGlowColor, params.glowColor || 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

export async function init(onRender) {
  renderCallback = onRender;
  canvas = document.getElementById('crt-canvas');
  gameCanvas = document.getElementById('game-canvas');

  gl = canvas.getContext('webgl2', { alpha: false, premultipliedAlpha: false });
  if (!gl) {
    gl = canvas.getContext('webgl', { alpha: false, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl', { alpha: false, premultipliedAlpha: false });
  }
  if (!gl) {
    console.error('WebGL not supported');
    return false;
  }

  // Fullscreen quad
  const quadVerts = new Float32Array([
    -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
  ]);
  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);

  // Game canvas texture
  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gameCanvas);

  // Load shaders
  let vertSrc, fragSrc;
  try {
    const results = await Promise.all([
      fetch('/shaders/crt.vert'),
      fetch('/shaders/crt.frag'),
    ]);
    vertSrc = await results[0].text();
    fragSrc = await results[1].text();
  } catch (e) {
    console.error('Failed to load shaders:', e);
    return false;
  }

  program = createProgram(vertSrc, fragSrc);
  if (!program) return false;

  gl.useProgram(program);

  // Attribute
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(aPosition);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  // Uniform locations
  const uniformNames = [
    'uTexture', 'uTime', 'uResolution', 'uOverlayMode',
    'uCurvature', 'uChromatic', 'uScanlineCount', 'uScanlineIntensity',
    'uBloomRadius', 'uBloomIntensity', 'uVignetteIntensity',
    'uFlickerIntensity', 'uNoiseIntensity', 'uJitterIntensity',
    'uJitterChance', 'uBrightness', 'uContrast', 'uSaturation', 'uGlowColor',
  ];
  for (const name of uniformNames) {
    uLocs[name] = gl.getUniformLocation(program, name);
  }

  gl.uniform1i(uLocs.uTexture, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);

  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 1);

  window.addEventListener('resize', resize);
  resize();

  // Start render loop
  lastTime = performance.now();
  requestAnimationFrame(frame);

  return true;
}

export function setParams(p) {
  Object.assign(params, p);
}
