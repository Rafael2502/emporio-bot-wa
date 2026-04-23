#!/usr/bin/env node
import * as readline from 'readline';

// ─── Parser de expressão ──────────────────────────────────────────────────────
// Substituição em passo único (mais longo primeiro) para evitar que uma
// substituição crie tokens que seriam capturados por regras posteriores.
// Exemplo do bug evitado: "ln" → "Math.log" → "log" matched por /\blog\b/ → "Math.Math.log10"

const KEYWORD_MAP = [
  // Funções hiperbólicas (antes das trigonométricas)
  ['sinh', 'Math.sinh'], ['cosh', 'Math.cosh'], ['tanh', 'Math.tanh'],
  // Trigonométricas inversas (antes das diretas)
  ['asin', 'Math.asin'], ['acos', 'Math.acos'], ['atan', 'Math.atan'],
  // Trigonométricas
  ['sin', 'Math.sin'], ['cos', 'Math.cos'], ['tan', 'Math.tan'],
  // Logaritmos (mais específicos antes de "log")
  ['log10', 'Math.log10'], ['log2', 'Math.log2'],
  ['ln', 'Math.log'], ['log', 'Math.log10'],
  // Raízes e outras
  ['sqrt', 'Math.sqrt'], ['cbrt', 'Math.cbrt'],
  ['abs', 'Math.abs'], ['exp', 'Math.exp'],
  ['floor', 'Math.floor'], ['ceil', 'Math.ceil'], ['sign', 'Math.sign'],
  // Constantes
  ['pi', 'Math.PI'],
].sort((a, b) => b[0].length - a[0].length); // mais longo primeiro garante match correto

const KW_REGEX = new RegExp(
  '\\b(' + KEYWORD_MAP.map(([k]) => k).join('|') + ')\\b',
  'gi'
);
const KW_LOOKUP = Object.fromEntries(KEYWORD_MAP.map(([k, v]) => [k.toLowerCase(), v]));

function parseExpression(expr) {
  let processed = expr.trim().replace(/\^/g, '**');

  // Passo único: substitui todas as palavras-chave de uma vez
  processed = processed.replace(KW_REGEX, (m) => KW_LOOKUP[m.toLowerCase()] ?? m);

  // "e" isolado como constante de Euler (não dentro de outras palavras ou dígitos)
  // Usa lookbehind/lookahead para não capturar notação científica (2e3) nem letras
  processed = processed.replace(/(?<![a-zA-Z0-9_])e(?![a-zA-Z0-9_])/g, 'Math.E');

  try {
    const fn = new Function('x', `"use strict"; return (${processed});`);
    fn(1); // smoke test de sintaxe
    return fn;
  } catch (err) {
    throw new Error(`Expressão inválida: ${err.message}`);
  }
}

// ─── Avaliação numérica ───────────────────────────────────────────────────────

// h mínimo de 1e-6: abaixo disso, funções como (1-cos(x))/x² sofrem
// cancelamento catastrófico em ponto flutuante de precisão dupla.
const H_VALUES = [0.1, 0.05, 0.01, 5e-3, 1e-3, 5e-4, 1e-4, 5e-5, 1e-5, 5e-6, 1e-6];

function evaluateOneSided(f, point, sign) {
  const samples = [];

  for (const h of H_VALUES) {
    try {
      const val = f(point + sign * h);
      if (!isNaN(val)) samples.push(val);
      else break;
    } catch {
      break;
    }
  }

  if (samples.length === 0) return null;

  const n = samples.length;
  const last = samples[n - 1];

  // Divergência explícita para ±∞ retornada pela função
  if (!isFinite(last)) return last;

  // Detecta divergência monotônica para ±∞ (valores crescem sem produzir Infinity)
  if (n >= 4) {
    const diffs = samples.slice(1).map((v, i) => v - samples[i]);
    const absDiffs = diffs.map(Math.abs);
    const allPos = diffs.every((d) => d > 0);
    const allNeg = diffs.every((d) => d < 0);
    if (allPos || allNeg) {
      const totalChange = Math.abs(samples[n - 1] - samples[0]);
      const lastDiff = absDiffs[absDiffs.length - 1];
      const accelerating = absDiffs.every((d, i) => i === 0 || d >= absDiffs[i - 1] * 0.75);
      // Diverge se cresce indefinidamente (totalChange grande e ainda mudando) OU acelerando
      if (accelerating || (totalChange > 4 && lastDiff > 0.3)) {
        return allPos ? Infinity : -Infinity;
      }
    }
  }

  // Localiza o melhor ponto de convergência varredura de trás para frente:
  // usa a janela onde |f(h_i) - f(h_{i-1})| é mínimo (menos ruído).
  let bestIdx = n - 1;
  let bestDiff = n >= 2 ? Math.abs(samples[n - 1] - samples[n - 2]) : 0;

  for (let i = n - 2; i >= 1; i--) {
    const d = Math.abs(samples[i] - samples[i - 1]);
    if (d <= bestDiff) {
      bestDiff = d;
      bestIdx = i;
    }
  }

  // Se nem no melhor ponto há convergência razoável → oscilação
  if (bestDiff > 0.05) return 'oscillating';

  // Extrapolação de Richardson O(h¹): L ≈ 2·f(h_small) − f(h_large)
  // Reduz o erro residual; se bestIdx == 0 não há par, retorna o valor direto.
  if (bestIdx >= 1) {
    const f1 = samples[bestIdx];
    const f2 = samples[bestIdx - 1];
    const rich = 2 * f1 - f2;
    // Só aplica se a extrapolação for estável (não amplifica demais o ruído)
    return Math.abs(rich - f1) < Math.abs(f1) * 0.1 + 1 ? rich : f1;
  }

  return samples[bestIdx];
}

// Limite no infinito: avalia em x cada vez maior e verifica estabilidade
function evaluateAtInfinity(f, sign) {
  const xValues = [1e2, 1e3, 1e4, 1e6, 1e8, 1e10];
  const samples = [];

  for (const x of xValues) {
    try {
      const val = f(sign * x);
      if (!isNaN(val)) samples.push(val);
      else break;
    } catch {
      break;
    }
  }

  if (samples.length < 2) return null;

  const last = samples[samples.length - 1];
  if (!isFinite(last)) return last;

  const diff = Math.abs(samples[samples.length - 1] - samples[samples.length - 2]);
  const scale = Math.abs(last) + 1;
  return diff / scale < 1e-3 ? last : null;
}

// ─── API principal ────────────────────────────────────────────────────────────

export function calculateLimit(expression, point, direction = 'both') {
  const f = parseExpression(expression);

  const ps = String(point).trim().toLowerCase();
  const isInfPos = ps === 'inf' || ps === '+inf' || ps === 'infinito' || ps === '+infinito';
  const isInfNeg = ps === '-inf' || ps === '-infinito';
  const numPoint = isInfPos ? Infinity : isInfNeg ? -Infinity : Number(point);

  if (!isInfPos && !isInfNeg && isNaN(numPoint)) {
    throw new Error(`Ponto inválido: "${point}". Use um número, "inf" ou "-inf".`);
  }

  if (isInfPos || isInfNeg) {
    const sign = isInfPos ? 1 : -1;
    const limit = evaluateAtInfinity(f, sign);
    const exists = limit !== null && limit !== 'oscillating';
    return { exists, limit: exists ? limit : null, point: isInfPos ? Infinity : -Infinity, direction };
  }

  const leftLimit  = direction !== 'right' ? evaluateOneSided(f, numPoint, -1) : undefined;
  const rightLimit = direction !== 'left'  ? evaluateOneSided(f, numPoint,  1) : undefined;

  return buildResult(leftLimit, rightLimit, direction, numPoint);
}

function buildResult(left, right, direction, point) {
  const bad = (v) => v === null || v === 'oscillating';

  if (direction === 'left')  return { exists: !bad(left),  limit: bad(left)  ? null : left,  leftLimit: left,  point, direction };
  if (direction === 'right') return { exists: !bad(right), limit: bad(right) ? null : right, rightLimit: right, point, direction };

  if (bad(left) || bad(right)) {
    return { exists: false, leftLimit: left, rightLimit: right, point, direction };
  }

  if (!isFinite(left) || !isFinite(right)) {
    const agrees = left === right;
    return { exists: agrees, limit: agrees ? left : null, leftLimit: left, rightLimit: right, point, direction };
  }

  if (Math.abs(left - right) < 1e-4) {
    return { exists: true, limit: (left + right) / 2, leftLimit: left, rightLimit: right, point, direction };
  }

  return { exists: false, leftLimit: left, rightLimit: right, point, direction };
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function fmtNum(val) {
  if (val === Infinity)  return '+∞';
  if (val === -Infinity) return '-∞';
  if (val === null || val === 'oscillating') return 'indefinido';
  if (Math.abs(val) < 1e-7) return '0';

  // Frações simples (tolerância 5e-5 para absorver erro residual de ponto flutuante)
  for (const denom of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const num = Math.round(val * denom);
    if (Math.abs(num / denom - val) < 5e-5) {
      return denom === 1 ? String(num) : `${num}/${denom}`;
    }
  }

  // Múltiplos de π
  const rPI = val / Math.PI;
  for (const denom of [1, 2, 3, 4, 6]) {
    const num = Math.round(rPI * denom);
    if (Math.abs(num / denom - rPI) < 1e-5 && num !== 0) {
      const pfx = num === 1 ? '' : num === -1 ? '-' : String(num);
      return denom === 1 ? `${pfx}π` : `${pfx}π/${denom}`;
    }
  }

  // Múltiplos de e
  const rE = val / Math.E;
  for (const denom of [1, 2, 3, 4]) {
    const num = Math.round(rE * denom);
    if (Math.abs(num / denom - rE) < 1e-4 && num !== 0) {
      const pfx = num === 1 ? '' : num === -1 ? '-' : String(num);
      return denom === 1 ? `${pfx}e` : `${pfx}e/${denom}`;
    }
  }

  return parseFloat(val.toPrecision(8)).toString();
}

function fmtPoint(point) {
  if (point === Infinity)  return '+∞';
  if (point === -Infinity) return '-∞';
  return fmtNum(point);
}

function printResult(result, expr) {
  const ptStr = fmtPoint(result.point);
  let arrow;
  if (result.direction === 'left')       arrow = `${ptStr}⁻`;
  else if (result.direction === 'right') arrow = `${ptStr}⁺`;
  else                                   arrow = ptStr;

  console.log(`\n  lim       f(x)   onde   f(x) = ${expr}`);
  console.log(`x → ${arrow}`);
  console.log('─'.repeat(50));

  if (result.exists) {
    console.log(`  Resultado: ${fmtNum(result.limit)}`);
  } else {
    console.log('  Resultado: LIMITE NÃO EXISTE');
    if (result.leftLimit !== undefined && result.rightLimit !== undefined) {
      console.log(`  Limite pela esquerda : ${fmtNum(result.leftLimit)}`);
      console.log(`  Limite pela direita  : ${fmtNum(result.rightLimit)}`);
    } else if (result.leftLimit !== undefined) {
      console.log(`  Limite pela esquerda : ${fmtNum(result.leftLimit)}`);
    } else if (result.rightLimit !== undefined) {
      console.log(`  Limite pela direita  : ${fmtNum(result.rightLimit)}`);
    }
  }
  console.log('─'.repeat(50));
}

// ─── CLI interativo ───────────────────────────────────────────────────────────

async function runInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║     CALCULADORA DE LIMITES (numérica)    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('\nFunções : sin cos tan asin acos atan sinh cosh tanh');
  console.log('          ln log log10 log2 sqrt cbrt abs exp');
  console.log('Constantes: pi  e');
  console.log('Potência  : ^ (ex: x^2)');
  console.log('Infinito  : inf  ou  -inf');
  console.log('\nDigite "sair" a qualquer momento para encerrar.\n');

  while (true) {
    const expr = (await ask('f(x) = ')).trim();
    if (expr.toLowerCase() === 'sair') break;
    if (!expr) continue;

    const pointRaw = (await ask('x  →  ')).trim();
    if (pointRaw.toLowerCase() === 'sair') break;

    const dirRaw = (await ask('Direção — esquerda / direita / ambos [ambos]: ')).trim().toLowerCase();
    const direction = dirRaw.startsWith('esq') ? 'left'
                    : dirRaw.startsWith('dir') ? 'right'
                    : 'both';

    try {
      const result = calculateLimit(expr, pointRaw, direction);
      printResult(result, expr);
    } catch (err) {
      console.log(`\n  ⚠  ${err.message}\n`);
    }

    const again = (await ask('\nCalcular outro? (s/n) [s]: ')).trim().toLowerCase();
    if (again === 'n' || again === 'não' || again === 'nao') break;
    console.log();
  }

  console.log('\nAté mais!\n');
  rl.close();
}

// ─── Entrada via argumentos: node limit-calculator.js "sin(x)/x" 0 ──────────

const args = process.argv.slice(2);

if (args.length >= 2) {
  const [expr, pointArg, dirArg] = args;
  const direction = dirArg === 'left' ? 'left' : dirArg === 'right' ? 'right' : 'both';
  try {
    const result = calculateLimit(expr, pointArg, direction);
    printResult(result, expr);
  } catch (err) {
    console.error(`Erro: ${err.message}`);
    process.exit(1);
  }
} else {
  runInteractive().catch(console.error);
}
