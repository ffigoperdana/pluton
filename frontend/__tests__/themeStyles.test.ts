import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const sass = require('sass-embedded');
const postcss = require('postcss');
const sourceRoot = new URL('../src/', import.meta.url);
const css = postcss.parse(sass.compile(fileURLToPath(new URL('styles/global.scss', sourceRoot))).css);
const palettes: Record<string, Record<string, string>> = { light: {}, dark: {} };
css.walkRules((rule: any) => {
   const selector = rule.selector.replace(/['"]/g, '');
   if (selector !== ':root' && selector !== '[data-theme=dark]') return;
   rule.walkDecls((decl: any) => {
      if (!decl.prop.startsWith('--')) return;
      palettes[selector === ':root' ? 'light' : 'dark'][decl.prop] = decl.value;
   });
});

function value(theme: string, token: string): string {
   const raw = palettes[theme][token] ?? palettes.light[token];
   assert.ok(raw, `Missing ${theme} token ${token}`);
   const alias = /^var\((--[\w-]+)\)$/.exec(raw);
   return alias ? value(theme, alias[1]) : raw;
}

function luminance(hex: string): number {
   assert.match(hex, /^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
   const expanded =
      hex.length === 4
         ? hex
              .slice(1)
              .split('')
              .map((part) => part + part)
              .join('')
         : hex.slice(1);
   return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const channel = parseInt(expanded.slice(index * 2, index * 2 + 2), 16) / 255;
      return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
   }, 0);
}

function contrast(theme: string, text: string, background: string): number {
   const a = luminance(value(theme, text));
   const b = luminance(value(theme, background));
   return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

for (const theme of ['light', 'dark']) {
   test(`${theme}: body, muted text, input values, placeholders and accent text remain readable`, () => {
      for (const foreground of [
         '--content-title-color',
         '--content-subtitle-color',
         '--content-text-color',
         '--content-text-color-light',
         '--primary-color-foreground',
      ]) {
         for (const background of ['--background-color', '--content-background-color', '--field-bg', '--primary-color-light']) {
            const ratio = contrast(theme, foreground, background);
            assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}`);
         }
      }
   });

   test(`${theme}: status labels, active states and solid buttons have readable foregrounds`, () => {
      for (const [text, background] of [
         ['--success-text-color', '--success-bg-color'],
         ['--success-text-color', '--success-bg-color-active'],
         ['--warning-text-color', '--warning-bg-color'],
         ['--error-text-color', '--error-bg-color'],
         ['--error-text-color', '--error-bg-color-active'],
         ['--primary-text-color', '--primary-color'],
         ['--error-active-text', '--error-button-color'],
         ['--progress-text', '--progress-fill'],
      ]) {
         const ratio = contrast(theme, text, background);
         assert.ok(ratio >= 4.5, `${text} on ${background}: ${ratio.toFixed(2)}`);
      }
      assert.ok(contrast(theme, '--content-text-color-light', '--line-color') >= 3, 'Disabled text must remain discernible');
      assert.ok(contrast(theme, '--field-line-color', '--field-bg') >= 3, 'Input boundary must remain discernible');
   });

   test(`${theme}: toggle OFF track is a visible neutral and both track states keep a readable thumb`, () => {
      for (const surface of ['--content-background-color', '--field-bg', '--surface-muted', '--background-color']) {
         const ratio = contrast(theme, '--toggle-track-off', surface);
         assert.ok(ratio >= 3, `--toggle-track-off on ${surface}: ${ratio.toFixed(2)}`);
      }
      for (const track of ['--toggle-track-off', '--primary-color']) {
         const ratio = contrast(theme, '--toggle-thumb', track);
         assert.ok(ratio >= 3, `--toggle-thumb on ${track}: ${ratio.toFixed(2)}`);
      }
      // OFF must read as neutral, never as a paler version of the purple ON accent.
      assert.ok(saturation(value(theme, '--toggle-track-off')) < 0.2, `--toggle-track-off is too saturated`);
   });
}

function saturation(hex: string): number {
   const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
   const max = Math.max(...channels),
      min = Math.min(...channels);
   const lightness = (max + min) / 2;
   return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
}

function sourceFiles(directory: URL): URL[] {
   return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const location = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      return entry.isDirectory() ? sourceFiles(location) : /\.(scss|tsx)$/.test(entry.name) ? [location] : [];
   });
}

test('all frontend color variables reference defined canonical tokens, not accidental aliases', () => {
   const sources = sourceFiles(sourceRoot).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
   const defined = new Set(sources.flatMap(({ text }) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])));
   for (const { path, text } of sources) {
      for (const match of text.matchAll(/var\((--[\w-]+)/g)) {
         if (match[1] === '--animation-duration') continue; // Locally supplied as a custom property in AnimatedWrapper.
         assert.ok(defined.has(match[1]), `${fileURLToPath(path)}: undefined ${match[1]}`);
      }
   }
});

test('browser controls use the chosen theme, with inherited text, placeholders and visible focus', () => {
   assert.ok(
      css.nodes.some(
         (rule: any) => rule.selector === ':root' && rule.nodes.some((decl: any) => decl.prop === 'color-scheme' && decl.value === 'light'),
      ),
   );
   assert.ok(
      css.nodes.some(
         (rule: any) =>
            rule.selector?.replace(/['"]/g, '') === '[data-theme=dark]' &&
            rule.nodes.some((decl: any) => decl.prop === 'color-scheme' && decl.value === 'dark'),
      ),
   );
   const controls = css.nodes.find((rule: any) => rule.selector === 'button,\ninput,\nselect,\ntextarea');
   assert.ok(controls.nodes.some((decl: any) => decl.prop === 'color' && decl.value === 'inherit'));
   assert.ok(css.toString().includes('input::placeholder'));
   assert.ok(css.toString().includes('button:focus-visible'));
   assert.equal(value('light', '--primary-color'), '#575aff');
   assert.equal(value('dark', '--primary-color'), '#575aff');
});

function compiled(path: string): any {
   return postcss.parse(sass.compile(fileURLToPath(new URL(path, sourceRoot))).css);
}

test('selected dropdown entries keep on-accent text in Dark and are not overwritten by hover', () => {
   const select = compiled('components/common/form/Select/Select.module.scss');
   const selected = select.nodes.find((rule: any) => rule.selector.endsWith('li.selectedItem'));
   assert.ok(selected.nodes.some((decl: any) => decl.prop === 'color' && decl.value === 'var(--primary-text-color)'));
   assert.ok(select.toString().includes(':hover:not(.selectedItem):not(.disabledItem)'));
   assert.ok(compiled('components/common/form/MultiSelect/MultiSelect.module.scss').toString().includes(':hover:not(.selectedItem)'));
});

test('Phase 4 errors and Phase 5 controls use the existing error/field/card palette', () => {
   for (const path of ['components/Device/AgentEnrollment/AgentEnrollment.module.scss', 'components/Device/AgentStatus/AgentStatus.module.scss']) {
      const error = compiled(path).nodes.find((rule: any) => rule.selector === '.error');
      assert.ok(error.nodes.some((decl: any) => decl.prop === 'color' && decl.value === 'var(--error-text-color)'));
   }
   const lifecycle = compiled('components/Plan/PlanSettings/PlanRemoteLifecycleSettings.module.scss').toString();
   assert.ok(lifecycle.includes('background: var(--field-bg)'));
   assert.ok(lifecycle.includes('background: var(--content-background-color)'));
   assert.ok(lifecycle.includes('border: 1px solid var(--field-line-color)'));
});

test('shared toggle stays keyboard reachable, shows focus and uses theme tokens instead of a hue gradient', () => {
   const toggle = compiled('components/common/form/Toggle/Toggle.module.scss');
   const rules = (match: (selector: string) => boolean) =>
      toggle.nodes.filter((rule: any) => rule.selector && match(rule.selector.replace(/['"]/g, '')));
   const declarations = (selector: string) => rules((s) => s === selector).flatMap((rule: any) => rule.nodes);
   const input = declarations('.toggleCheckbox input[type=checkbox]');
   assert.ok(input.length, 'native checkbox rule exists');
   assert.ok(
      !input.some((decl: any) => decl.prop === 'visibility' && decl.value === 'hidden'),
      'visibility:hidden removes the switch from tab order',
   );
   assert.ok(!input.some((decl: any) => decl.prop === 'display' && decl.value === 'none'), 'display:none removes the switch from tab order');
   const focus = rules((s) => s.includes('input:focus-visible + label'));
   assert.ok(focus.some((rule: any) => rule.nodes.some((decl: any) => decl.prop === 'outline' && decl.value.includes('var(--line-active-color)'))));
   assert.ok(declarations('.toggleCheckbox label').some((decl: any) => decl.prop === 'background' && decl.value === 'var(--toggle-track-off)'));
   assert.ok(declarations('.toggleCheckbox label:after').some((decl: any) => decl.prop === 'background' && decl.value === 'var(--toggle-thumb)'));
   assert.ok(
      declarations('.toggleCheckbox input:checked + label').some((decl: any) => decl.prop === 'background' && decl.value === 'var(--primary-color)'),
   );
   assert.ok(!toggle.toString().includes('gradient'), 'no hue gradient on the ON track');
   const component = readFileSync(new URL('components/common/form/Toggle/Toggle.tsx', sourceRoot), 'utf8');
   assert.ok(component.includes('role="switch"'), 'assistive technology announces on/off');
});

test('text, status dots and badges use theme-aware semantic tokens instead of fills or fixed named colors', () => {
   const sources = sourceFiles(sourceRoot)
      .filter((path) => path.pathname.endsWith('.scss'))
      .map((path) => ({ path: fileURLToPath(path), text: readFileSync(path, 'utf8') }));
   for (const { path, text } of sources) {
      // --error-button-color is a fill behind white text; as text it is ~3:1 on Dark cards.
      assert.ok(!/^\s*color:\s*var\(--error-button-color\)/m.test(text), `${path}: error text must use --error-text-color`);
      assert.ok(!/:\s*turquoise\b/.test(text), `${path}: use a semantic token instead of turquoise`);
      assert.ok(!/var\((?!--)[\w-]+/.test(text), `${path}: var() without "--" is silently ignored`);
   }
   const dot = compiled('components/Device/DeviceItem/DeviceItem.module.scss').toString();
   assert.ok(!dot.includes('background-color: var(--line-active-color)'), 'disconnected dot must not use the Dark accent');
   const badge = compiled('routes/Mcp/Mcp.module.scss').nodes.find((rule: any) => rule.selector === '.badge');
   assert.ok(badge.nodes.some((decl: any) => decl.prop === 'color' && decl.value === 'var(--primary-color-foreground)'));
   assert.ok(badge.nodes.some((decl: any) => decl.prop === 'background' && decl.value === 'var(--primary-color-light)'));
});

test('status badges, selected files and toast surfaces no longer bypass the shared palette', () => {
   const global = css.toString();
   assert.ok(global.includes('background-color: var(--success-bg-color)'));
   const selected = compiled('components/common/FileManager/FileManager.module.scss').nodes.find((rule: any) => rule.selector === '.selected');
   assert.ok(selected.nodes.some((decl: any) => decl.prop === 'background' && decl.value === 'var(--primary-color-light)'));
   const toast = css.nodes.find((rule: any) => rule.selector === '.Toastify__toast-theme--light,\n.Toastify__toast-theme--dark');
   assert.ok(toast.nodes.some((decl: any) => decl.prop === 'background' && decl.value === 'var(--content-background-color)'));
});
