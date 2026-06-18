/**
 * yaml.ts — mini YAML loader (subset พอสำหรับ discord.config.yaml)
 * รองรับ: nested maps (indent 2-space), list ของ block-maps (`- key: val`), scalar,
 *         comments (#), quoted strings, number/bool coercion. ไม่มี dep, typed (no any).
 *
 * — Tonk Oracle 🌿
 */
export type YamlValue = string | number | boolean | YamlValue[] | { [k: string]: YamlValue };

interface Line { indent: number; text: string }

function lex(src: string): Line[] {
  return src.split("\n")
    .map((raw) => raw.replace(/\t/g, "  "))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim().replace(/\s+#.*$/, "") }));
}

function scalar(s: string): YamlValue {
  const v = s.trim();
  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  // list?
  if (lines[start]?.text.startsWith("- ")) {
    const arr: YamlValue[] = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const first = lines[i].text.slice(2);
      const obj: { [k: string]: YamlValue } = {};
      // first inline pair on the dash line
      const m = first.match(/^([^:]+):\s*(.*)$/);
      if (m) obj[m[1].trim()] = scalar(m[2]);
      i++;
      // following deeper-indented pairs belong to this list item
      while (i < lines.length && lines[i].indent > indent) {
        const [val, next] = parseBlock(lines, i, lines[i].indent);
        Object.assign(obj, val as { [k: string]: YamlValue });
        i = next;
        break;
      }
      arr.push(obj);
    }
    return [arr, i];
  }
  // map
  const map: { [k: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^([^:]+):\s*(.*)$/);
    if (!m) break;
    const key = m[1].trim();
    const inline = m[2];
    if (inline !== "") { map[key] = scalar(inline); i++; continue; }
    // nested block (deeper indent)
    if (i + 1 < lines.length && lines[i + 1].indent > indent) {
      const childIndent = lines[i + 1].indent;
      const [val, next] = parseBlock(lines, i + 1, lines[i + 1].text.startsWith("- ") ? childIndent : childIndent);
      map[key] = val;
      i = next;
    } else { map[key] = ""; i++; }
  }
  return [map, i];
}

export function parseYaml(src: string): { [k: string]: YamlValue } {
  const lines = lex(src);
  const [val] = parseBlock(lines, 0, 0);
  return val as { [k: string]: YamlValue };
}
