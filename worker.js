// worker.js — REINFORCE Policy Gradient Agent
// Nomenclature follows Sutton & Barto "Reinforcement Learning" 2nd ed.
// and Williams 1992 "Simple Statistical Gradient-Following Algorithms"
//
// The agent trains continuously (at a deliberately throttled pace so the
// learning curve is watchable). On request, it plays back the CURRENT policy as
// a slow, deterministic "demo" rollout — so each successive demo reflects more
// training, and the viewer watches the arm get better at pressing the button
// over time, with the episode count always increasing.

'use strict';

// ─── ARCHITECTURE ────────────────────────────────────────────────────────────
const D_IN   = 6;   // [θ1, θ2, dθ1, dθ2, Δx_target, Δy_target]
const D_H    = 32;  // hidden units per layer
const D_OUT  = 2;   // [μ1, μ2] — means of Gaussian policy

// ─── NETWORK PARAMETERS (theta in Williams 1992) ─────────────────────────────
const theta = {
  W1: new Float64Array(D_H  * D_IN),   // (32,6)
  b1: new Float64Array(D_H),
  W2: new Float64Array(D_H  * D_H),    // (32,32)
  b2: new Float64Array(D_H),
  W3: new Float64Array(D_OUT * D_H),   // (2,32)
  b3: new Float64Array(D_OUT),
};

function xavier(n, fan_in) {
  const s = Math.sqrt(2.0 / fan_in);
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * s;
  return a;
}

function init_network() {
  theta.W1 = xavier(D_H  * D_IN,  D_IN);
  theta.b1 = new Float64Array(D_H);
  theta.W2 = xavier(D_H  * D_H,   D_H);
  theta.b2 = new Float64Array(D_H);
  theta.W3 = xavier(D_OUT * D_H,  D_H);
  theta.b3 = new Float64Array(D_OUT);
}

// ─── FORWARD PASS (pure — operates on a given weight set W) ──────────────────
function forward_W(W, x) {
  // h1 = tanh(W1 x + b1)
  const h1 = new Float64Array(D_H);
  for (let i = 0; i < D_H; i++) {
    let v = W.b1[i];
    for (let j = 0; j < D_IN; j++) v += W.W1[i * D_IN + j] * x[j];
    h1[i] = Math.tanh(v);
  }
  // h2 = tanh(W2 h1 + b2)
  const h2 = new Float64Array(D_H);
  for (let i = 0; i < D_H; i++) {
    let v = W.b2[i];
    for (let j = 0; j < D_H; j++) v += W.W2[i * D_H + j] * h1[j];
    h2[i] = Math.tanh(v);
  }
  // mu = W3 h2 + b3  (linear output — policy means)
  const mu = new Float64Array(D_OUT);
  for (let i = 0; i < D_OUT; i++) {
    let v = W.b3[i];
    for (let j = 0; j < D_H; j++) v += W.W3[i * D_H + j] * h2[j];
    mu[i] = v;
  }
  return { h1, h2, mu };
}

function forward(x) { return forward_W(theta, x); }

// ─── GRADIENT OF log π(a|s) w.r.t. ALL network parameters ──────────────────
// For a Gaussian π(a|s) = N(μ(s), σ²I):
//   ∂log π / ∂μ_i = (a_i − μ_i) / σ²
// Then backprop through the MLP using the chain rule.
function log_prob_grad(x, h1, h2, mu, actions, sigma) {
  const sig2 = sigma * sigma;

  const d_mu = new Float64Array(D_OUT);
  for (let i = 0; i < D_OUT; i++) d_mu[i] = (actions[i] - mu[i]) / sig2;

  // Layer 3
  const g_W3 = new Float64Array(D_OUT * D_H);
  const g_b3 = new Float64Array(D_OUT);
  for (let i = 0; i < D_OUT; i++) {
    g_b3[i] = d_mu[i];
    for (let j = 0; j < D_H; j++) g_W3[i * D_H + j] = d_mu[i] * h2[j];
  }

  // Backprop into h2
  const d_h2 = new Float64Array(D_H);
  for (let j = 0; j < D_H; j++) {
    let s = 0;
    for (let i = 0; i < D_OUT; i++) s += theta.W3[i * D_H + j] * d_mu[i];
    d_h2[j] = s * (1 - h2[j] * h2[j]);
  }

  // Layer 2
  const g_W2 = new Float64Array(D_H * D_H);
  const g_b2 = new Float64Array(D_H);
  for (let i = 0; i < D_H; i++) {
    g_b2[i] = d_h2[i];
    for (let j = 0; j < D_H; j++) g_W2[i * D_H + j] = d_h2[i] * h1[j];
  }

  // Backprop into h1
  const d_h1 = new Float64Array(D_H);
  for (let j = 0; j < D_H; j++) {
    let s = 0;
    for (let i = 0; i < D_H; i++) s += theta.W2[i * D_H + j] * d_h2[i];
    d_h1[j] = s * (1 - h1[j] * h1[j]);
  }

  // Layer 1
  const g_W1 = new Float64Array(D_H * D_IN);
  const g_b1 = new Float64Array(D_H);
  for (let i = 0; i < D_H; i++) {
    g_b1[i] = d_h1[i];
    for (let j = 0; j < D_IN; j++) g_W1[i * D_IN + j] = d_h1[i] * x[j];
  }

  return { g_W1, g_b1, g_W2, g_b2, g_W3, g_b3 };
}

// ─── SAMPLING ─────────────────────────────────────────────────────────────────
function randn() {  // Box-Muller
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function log_gaussian(a, mu, sigma) {
  const d = a - mu;
  return -0.5 * d * d / (sigma * sigma) - Math.log(sigma) - 0.5 * Math.log(2 * Math.PI);
}

// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
const L1 = 0.55, L2 = 0.45;   // link lengths (normalized)
const T1_MIN = 0.05,            T1_MAX = Math.PI - 0.05;
const T2_MIN = -Math.PI * 0.75, T2_MAX = Math.PI * 0.75;

function fk(t1, t2) {
  return {
    ex: L1 * Math.cos(t1) + L2 * Math.cos(t1 + t2),
    ey: L1 * Math.sin(t1) + L2 * Math.sin(t1 + t2),
  };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── HYPER-PARAMETERS (mutable via postMessage) ──────────────────────────────
let alpha      = 5e-3;
let gamma      = 0.98;
let beta       = 0.01;
let dense_mode = true;

// Mini-batch REINFORCE: averaging the gradient over several trajectories per
// update — combined with advantage normalization — dramatically reduces the
// notorious variance of vanilla policy gradients, so the policy converges to
// precise target-reaching control instead of just "getting close".
const BATCH = 16;

// σ schedule keyed to *update count*: exploration noise decays 0.7 → 0.10
// quadratically over 250 gradient updates. Training uses a fresh random target
// every episode, so the policy learns a general reaching controller.
let episode_count = 0;
let update_count  = 0;
const SIGMA_START = 0.7, SIGMA_END = 0.10, SIGMA_UPDATES = 250;
function get_sigma() {
  if (update_count >= SIGMA_UPDATES) return SIGMA_END;
  const t = update_count / SIGMA_UPDATES;
  return SIGMA_START + (SIGMA_END - SIGMA_START) * t * t;
}

// ─── EPISODE CONFIG ───────────────────────────────────────────────────────────
const MAX_STEPS  = 160;
const HIT_THRESH = 0.12;    // matches the drawn button radius — a visible touch
const DELTA_MAX  = 0.09;    // smaller max step → finer settling near the target

// baseline shown in the UI (mean batch return)
let baseline = 0.0;

// ─── HISTORY (circular buffer, 200 episodes) ─────────────────────────────────
const H = 200;
const hist_reward    = new Float32Array(H);
const hist_entropy   = new Float32Array(H);
const hist_grad_norm = new Float32Array(H);
const hist_mu1       = new Float32Array(H);
const hist_sigma     = new Float32Array(H);
let   hist_ptr       = 0;
let   success_total  = 0;

// ─── TARGET SAMPLING ──────────────────────────────────────────────────────────
// The button only appears in a small fixed zone to the lower-right of the arm —
// as if it sat on a table. Restricting the task to this compact region (instead
// of the whole 360° workspace) makes the reaching controller easy and RELIABLE
// to learn, so the trained policy dependably presses the button every run.
function sample_target() {
  for (let i = 0; i < 600; i++) {
    const t1 = Math.random() * (T1_MAX - T1_MIN) + T1_MIN;
    const t2 = Math.random() * (T2_MAX - T2_MIN) + T2_MIN;
    const p  = fk(t1, t2);
    const r  = Math.hypot(p.ex, p.ey);
    // Lower-right band: right of the shoulder, at/below shoulder height.
    if (r > 0.45 && r < 0.80 && p.ex > 0.32 && p.ey > -0.38 && p.ey < 0.08)
      return { x: p.ex, y: p.ey };
  }
  return { x: 0.58, y: -0.15 };
}
let target = { x: 0.58, y: -0.15 };
const random_target = sample_target;

// ─── DETERMINISTIC GREEDY ROLLOUT (for demos — no exploration noise) ─────────
// Uses the policy mean μ directly (σ = 0). This reveals the *true skill* of the
// policy right now: early on it wanders, and it gets better as training advances.
function greedy_rollout(W, tgt) {
  let t1 = Math.PI * 0.5, t2 = 0.0;
  let dt1 = 0, dt2 = 0;
  const frames = [];
  let min_dist = Infinity;
  let success = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    const p = fk(t1, t2);
    const dx = tgt.x - p.ex, dy = tgt.y - p.ey;
    const dist = Math.hypot(dx, dy);
    if (dist < min_dist) min_dist = dist;

    frames.push({ t1, t2, ex: p.ex, ey: p.ey, dist });

    if (dist < HIT_THRESH) { success = true; break; }

    const state = new Float64Array([t1, t2, dt1, dt2, dx, dy]);
    const { mu } = forward_W(W, state);
    dt1 = clamp(mu[0], -DELTA_MAX, DELTA_MAX);
    dt2 = clamp(mu[1], -DELTA_MAX, DELTA_MAX);
    t1 = clamp(t1 + dt1, T1_MIN, T1_MAX);
    t2 = clamp(t2 + dt2, T2_MIN, T2_MAX);
  }
  return { frames, success, min_dist };
}

// ─── COLLECT ONE TRAJECTORY (no weight update — just roll out the policy) ────
function collect_episode(sigma) {
  // Fresh random target each episode → a general reaching controller.
  const tgt = random_target();

  let t1 = Math.PI * 0.5 + (Math.random() - 0.5) * 0.3;
  let t2 = (Math.random() - 0.5) * 0.3;
  let dt1 = 0, dt2 = 0;

  const steps = [];
  let total_reward = 0;
  let success = false;

  let p = fk(t1, t2);
  let prev_dist = Math.hypot(tgt.x - p.ex, tgt.y - p.ey);

  for (let step = 0; step < MAX_STEPS; step++) {
    p = fk(t1, t2);
    const dx = tgt.x - p.ex, dy = tgt.y - p.ey;

    const state = new Float64Array([t1, t2, dt1, dt2, dx, dy]);
    const { h1, h2, mu } = forward(state);

    const a1 = mu[0] + sigma * randn();
    const a2 = mu[1] + sigma * randn();

    dt1 = clamp(a1, -DELTA_MAX, DELTA_MAX);
    dt2 = clamp(a2, -DELTA_MAX, DELTA_MAX);
    t1  = clamp(t1 + dt1, T1_MIN, T1_MAX);
    t2  = clamp(t2 + dt2, T2_MIN, T2_MAX);

    const p2 = fk(t1, t2);
    const dist2 = Math.hypot(tgt.x - p2.ex, tgt.y - p2.ey);

    let reward;
    if (dist2 < HIT_THRESH)          { reward = 10.0; success = true; }
    else if (step === MAX_STEPS - 1) { reward = -1.0; }
    // Progress-based shaping: reward motion TOWARD the target (telescopes to the
    // total distance closed) minus a tiny step cost. Avoids the degenerate
    // optimum that an always-negative −‖e‖ term can collapse into.
    else if (dense_mode)             { reward = 4.0 * (prev_dist - dist2) - 0.02; }
    else                             { reward = 0.0; }

    prev_dist = dist2;
    total_reward += reward;

    steps.push({ state, a1, a2, reward, h1, h2, mu: new Float64Array([mu[0], mu[1]]) });
    if (success) break;
  }
  return { steps, total_reward, success };
}

// ─── MINI-BATCH REINFORCE UPDATE ─────────────────────────────────────────────
function run_batch() {
  const sigma = get_sigma();

  // 1) Collect BATCH trajectories and their discounted returns
  const episodes = [];
  const all_returns = [];
  let batch_reward = 0, batch_success = 0;
  let last_mu = 0;

  for (let b = 0; b < BATCH; b++) {
    const ep = collect_episode(sigma);
    const R = new Float64Array(ep.steps.length);
    let G = 0;
    for (let t = ep.steps.length - 1; t >= 0; t--) { G = ep.steps[t].reward + gamma * G; R[t] = G; }
    for (let t = 0; t < R.length; t++) all_returns.push(R[t]);

    episodes.push({ steps: ep.steps, returns: R });
    batch_reward += ep.total_reward;
    if (ep.success) { batch_success++; success_total++; }
    if (ep.steps.length) last_mu = ep.steps[ep.steps.length - 1].mu[0];
    episode_count++;
  }

  // 2) Standardize returns across the whole batch → normalized advantages
  const n = all_returns.length;
  const mean = all_returns.reduce((s, v) => s + v, 0) / n;
  let varSum = 0;
  for (const v of all_returns) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / n) + 1e-8;
  baseline = mean;

  // 3) Accumulate the gradient over every (state, action) in the batch
  const G_W1 = new Float64Array(D_H * D_IN),  G_b1 = new Float64Array(D_H);
  const G_W2 = new Float64Array(D_H * D_H),   G_b2 = new Float64Array(D_H);
  const G_W3 = new Float64Array(D_OUT * D_H), G_b3 = new Float64Array(D_OUT);

  let count = 0;
  for (const ep of episodes) {
    for (let t = 0; t < ep.steps.length; t++) {
      const { state, a1, a2, h1, h2, mu } = ep.steps[t];
      const advantage = (ep.returns[t] - mean) / std;
      const g = log_prob_grad(state, h1, h2, mu, [a1, a2], sigma);
      for (let i = 0; i < G_W1.length; i++) G_W1[i] += g.g_W1[i] * advantage;
      for (let i = 0; i < G_b1.length; i++) G_b1[i] += g.g_b1[i] * advantage;
      for (let i = 0; i < G_W2.length; i++) G_W2[i] += g.g_W2[i] * advantage;
      for (let i = 0; i < G_b2.length; i++) G_b2[i] += g.g_b2[i] * advantage;
      for (let i = 0; i < G_W3.length; i++) G_W3[i] += g.g_W3[i] * advantage;
      for (let i = 0; i < G_b3.length; i++) G_b3[i] += g.g_b3[i] * advantage;
      count++;
    }
  }
  for (let i = 0; i < G_W1.length; i++) G_W1[i] /= count;
  for (let i = 0; i < G_b1.length; i++) G_b1[i] /= count;
  for (let i = 0; i < G_W2.length; i++) G_W2[i] /= count;
  for (let i = 0; i < G_b2.length; i++) G_b2[i] /= count;
  for (let i = 0; i < G_W3.length; i++) G_W3[i] /= count;
  for (let i = 0; i < G_b3.length; i++) G_b3[i] /= count;

  // 4) Gradient norm + global-norm clipping
  let grad_norm = 0;
  for (let i = 0; i < G_W1.length; i++) grad_norm += G_W1[i] * G_W1[i];
  for (let i = 0; i < G_W2.length; i++) grad_norm += G_W2[i] * G_W2[i];
  for (let i = 0; i < G_W3.length; i++) grad_norm += G_W3[i] * G_W3[i];
  grad_norm = Math.sqrt(grad_norm);

  const CLIP = 2.0;
  if (grad_norm > CLIP) {
    const s = CLIP / grad_norm;
    for (let i = 0; i < G_W1.length; i++) G_W1[i] *= s;
    for (let i = 0; i < G_b1.length; i++) G_b1[i] *= s;
    for (let i = 0; i < G_W2.length; i++) G_W2[i] *= s;
    for (let i = 0; i < G_b2.length; i++) G_b2[i] *= s;
    for (let i = 0; i < G_W3.length; i++) G_W3[i] *= s;
    for (let i = 0; i < G_b3.length; i++) G_b3[i] *= s;
  }

  // 5) SGD ascent on J(θ)
  for (let i = 0; i < theta.W1.length; i++) theta.W1[i] += alpha * G_W1[i];
  for (let i = 0; i < theta.b1.length; i++) theta.b1[i] += alpha * G_b1[i];
  for (let i = 0; i < theta.W2.length; i++) theta.W2[i] += alpha * G_W2[i];
  for (let i = 0; i < theta.b2.length; i++) theta.b2[i] += alpha * G_b2[i];
  for (let i = 0; i < theta.W3.length; i++) theta.W3[i] += alpha * G_W3[i];
  for (let i = 0; i < theta.b3.length; i++) theta.b3[i] += alpha * G_b3[i];

  update_count++;

  // Entropy  H(π) = 0.5·ln(2πe·σ²)
  const entropy = 0.5 * Math.log(2 * Math.PI * Math.E * sigma * sigma);
  const avg_reward = batch_reward / BATCH;

  // History (one sample per update)
  hist_reward[hist_ptr]    = avg_reward;
  hist_entropy[hist_ptr]   = entropy;
  hist_grad_norm[hist_ptr] = Math.min(grad_norm, 5.0);
  hist_mu1[hist_ptr]       = last_mu;
  hist_sigma[hist_ptr]     = sigma;
  hist_ptr = (hist_ptr + 1) % H;

  self.postMessage({
    type: 'episode',
    episode: episode_count,
    total_reward: avg_reward,
    entropy,
    grad_norm: Math.min(grad_norm, 5.0),
    sigma,
    success: batch_success > 0,
    success_rate: success_total / episode_count,
    baseline,
    mu_last: last_mu,
    hist_reward:    Array.from(hist_reward),
    hist_entropy:   Array.from(hist_entropy),
    hist_grad_norm: Array.from(hist_grad_norm),
    hist_mu1:       Array.from(hist_mu1),
    hist_sigma:     Array.from(hist_sigma),
    hist_ptr,
  });
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
self.onmessage = (e) => {
  const { type, value, index, target: reqTarget } = e.data;
  if (type === 'set_alpha') alpha      = value;
  if (type === 'set_gamma') gamma      = value;
  if (type === 'set_beta')  beta       = value;
  if (type === 'set_dense') dense_mode = value;

  if (type === 'request_demo') {
    // Roll out the LATEST policy (current weights) on a fresh button in the
    // lower-right zone. Early on the policy misses; as episode_count climbs it
    // reliably presses the button — so each demo is better than the last.
    const tgt  = sample_target();
    const roll = greedy_rollout(theta, tgt);
    self.postMessage({
      type: 'demo',
      episode: episode_count,
      target: tgt,
      frames: roll.frames,
      success: roll.success,
      min_dist: roll.min_dist,
    });
  }
};

// ─── MAIN TRAINING LOOP ───────────────────────────────────────────────────────
// Deliberately paced (not full-speed): a fixed delay between updates spreads the
// learning curve over ~the first minute, so a viewer watching the live demos
// actually sees the policy get better over time instead of converging instantly.
init_network();
const UPDATE_DELAY_MS = 120;
function training_loop() {
  run_batch();
  setTimeout(training_loop, UPDATE_DELAY_MS);
}
setTimeout(training_loop, 100);
