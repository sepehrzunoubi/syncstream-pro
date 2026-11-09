/**
 * A Google Sheet in memory, for tests: it takes the batchUpdate requests a sync sends (the ones
 * steps.ts builds) and keeps what a real spreadsheet would, so a test can run a whole sync and
 * compare the result with the workbook it came from. Unknown requests throw: a new kind of step
 * can't pass a test without the stub understanding it.
 */

import type { Rect } from "./model";
import type { SheetsRequest } from "./steps";

export interface StubCell {
  value?: Record<string, unknown>;
  format?: Record<string, unknown>;
  note?: string;
  runs?: unknown[];
}

export interface StubSheet {
  id: number;
  title: string;
  index: number;
  rowCount: number;
  colCount: number;
  hidden?: boolean;
  rightToLeft?: boolean;
  hideGridlines?: boolean;
  frozenRows: number;
  frozenCols: number;
  tabColor?: unknown;
  cells: Map<string, StubCell>;
  merges: Rect[];
  rowPx: Map<number, number>;
  colPx: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  validations: { rect: Rect; rule: unknown }[];
  conditional: unknown[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) { if (!isObj(cur)) return undefined; cur = cur[p]; }
  return cur;
}

function setPath(obj: Obj, path: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (!isObj(next)) { if (value === undefined) return; cur[path[i]] = {}; }
    cur = cur[path[i]] as Obj;
  }
  const leaf = path[path.length - 1];
  if (value === undefined) delete cur[leaf];
  else cur[leaf] = structuredClone(value);
}

/** Drop objects left empty by a cleared field */
function prune(obj: Obj): Obj | undefined {
  for (const [k, v] of Object.entries(obj)) {
    if (isObj(v)) { const p = prune(v); if (p) obj[k] = p; else delete obj[k]; }
  }
  return Object.keys(obj).length ? obj : undefined;
}

export class StubSpreadsheet {
  title = "Untitled spreadsheet";
  theme: unknown = null;
  sheets = new Map<number, StubSheet>();
  namedRanges = new Map<string, { name: string; range: Obj }>();
  /** Every batch received, in order */
  batches: SheetsRequest[][] = [];

  constructor() {
    this.addSheet({ sheetId: 0, title: "Sheet1", index: 0 });
  }

  private addSheet(props: Obj): StubSheet {
    const id = Number(props.sheetId ?? 0);
    if (this.sheets.has(id)) throw Object.assign(new Error(`Invalid requests: addSheet: A sheet with the ID "${id}" already exists`), { code: 400 });
    const title = String(props.title ?? `Sheet${this.sheets.size + 1}`);
    for (const s of this.sheets.values()) if (s.title === title) throw Object.assign(new Error(`Invalid requests: addSheet: A sheet with the name "${title}" already exists`), { code: 400 });
    const grid = (props.gridProperties ?? {}) as Obj;
    const sheet: StubSheet = {
      id, title, index: Number(props.index ?? this.sheets.size), rowCount: Number(grid.rowCount ?? 1000), colCount: Number(grid.columnCount ?? 26),
      frozenRows: 0, frozenCols: 0, cells: new Map(), merges: [], rowPx: new Map(), colPx: new Map(), hiddenRows: new Set(), hiddenCols: new Set(), validations: [], conditional: [],
      ...(props.rightToLeft ? { rightToLeft: true } : {}),
    };
    this.sheets.set(id, sheet);
    return sheet;
  }

  private sheet(id: unknown): StubSheet {
    const sheet = this.sheets.get(Number(id ?? 0));
    if (!sheet) throw Object.assign(new Error(`Invalid requests: No grid with id: ${id}`), { code: 400 });
    return sheet;
  }

  private rect(sheet: StubSheet, range: Obj): Rect {
    const r0 = Number(range.startRowIndex ?? 0), r1 = Number(range.endRowIndex ?? sheet.rowCount) - 1;
    const c0 = Number(range.startColumnIndex ?? 0), c1 = Number(range.endColumnIndex ?? sheet.colCount) - 1;
    if (r1 >= sheet.rowCount || c1 >= sheet.colCount || r0 > r1 || c0 > c1) throw Object.assign(new Error("Invalid requests: range exceeds grid limits"), { code: 400 });
    return [r0, c0, r1, c1];
  }

  private cell(sheet: StubSheet, r: number, c: number): StubCell {
    const key = `${r},${c}`;
    let cell = sheet.cells.get(key);
    if (!cell) { cell = {}; sheet.cells.set(key, cell); }
    return cell;
  }

  /** Write the masked fields of `data` into a cell: a field the data leaves out is cleared */
  private write(sheet: StubSheet, r: number, c: number, data: Obj, fields: string[]): void {
    if (r >= sheet.rowCount || c >= sheet.colCount) throw Object.assign(new Error("Invalid requests: cell outside the grid"), { code: 400 });
    const cell = this.cell(sheet, r, c);
    for (const field of fields) {
      const path = field.split(".");
      if (path[0] === "userEnteredValue") { if (data.userEnteredValue === undefined) delete cell.value; else cell.value = structuredClone(data.userEnteredValue) as Obj; }
      else if (path[0] === "note") { if (data.note === undefined) delete cell.note; else cell.note = String(data.note); }
      else if (path[0] === "textFormatRuns") { if (data.textFormatRuns === undefined) delete cell.runs; else cell.runs = structuredClone(data.textFormatRuns) as unknown[]; }
      else if (path[0] === "userEnteredFormat") {
        if (path.length === 1) { if (data.userEnteredFormat === undefined) delete cell.format; else cell.format = structuredClone(data.userEnteredFormat) as Obj; }
        else {
          const format = cell.format ?? {};
          setPath(format, path.slice(1), getPath(data.userEnteredFormat, path.slice(1)));
          cell.format = prune(format);
          if (!cell.format) delete cell.format;
        }
      } else throw new Error(`stub: unknown field ${field}`);
    }
  }

  batchUpdate(requests: SheetsRequest[]): void {
    this.batches.push(structuredClone(requests));
    for (const request of requests) {
      const [kind, body] = Object.entries(request)[0] as [string, Obj];
      switch (kind) {
        case "updateSpreadsheetProperties": {
          const p = body.properties as Obj;
          for (const f of String(body.fields).split(",")) {
            if (f === "spreadsheetTheme") this.theme = structuredClone(p.spreadsheetTheme);
            else if (f === "title") this.title = String(p.title);
            else throw new Error(`stub: unknown spreadsheet field ${f}`);
          }
          break;
        }
        case "addSheet": this.addSheet(body.properties as Obj); break;
        case "updateSheetProperties": {
          const p = body.properties as Obj;
          const sheet = this.sheet(p.sheetId);
          const grid = (p.gridProperties ?? {}) as Obj;
          for (const f of String(body.fields).split(",")) {
            if (f === "title") {
              for (const s of this.sheets.values()) if (s !== sheet && s.title === p.title) throw Object.assign(new Error("Invalid requests: a sheet with that name already exists"), { code: 400 });
              sheet.title = String(p.title);
            }
            else if (f === "gridProperties.rowCount") sheet.rowCount = Number(grid.rowCount);
            else if (f === "gridProperties.columnCount") sheet.colCount = Number(grid.columnCount);
            else if (f === "gridProperties.hideGridlines") sheet.hideGridlines = !!grid.hideGridlines;
            else if (f === "gridProperties.frozenRowCount") sheet.frozenRows = Number(grid.frozenRowCount ?? 0);
            else if (f === "gridProperties.frozenColumnCount") sheet.frozenCols = Number(grid.frozenColumnCount ?? 0);
            else if (f === "tabColorStyle") sheet.tabColor = structuredClone(p.tabColorStyle);
            else if (f === "hidden") sheet.hidden = !!p.hidden;
            else if (f === "rightToLeft") sheet.rightToLeft = !!p.rightToLeft;
            else throw new Error(`stub: unknown sheet field ${f}`);
          }
          break;
        }
        case "updateCells": {
          const start = body.start as Obj | undefined;
          const range = body.range as Obj | undefined;
          const sheet = this.sheet((start ?? range)?.sheetId);
          const r0 = Number(start ? start.rowIndex ?? 0 : range!.startRowIndex ?? 0);
          const c0 = Number(start ? start.columnIndex ?? 0 : range!.startColumnIndex ?? 0);
          const fields = String(body.fields).split(",");
          ((body.rows ?? []) as Obj[]).forEach((row, dr) => {
            ((row.values ?? []) as Obj[]).forEach((data, dc) => this.write(sheet, r0 + dr, c0 + dc, data, fields));
          });
          break;
        }
        case "repeatCell": {
          const sheet = this.sheet((body.range as Obj).sheetId);
          const [r0, c0, r1, c1] = this.rect(sheet, body.range as Obj);
          const fields = String(body.fields).split(",");
          for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.write(sheet, r, c, body.cell as Obj, fields);
          break;
        }
        case "mergeCells": {
          const sheet = this.sheet((body.range as Obj).sheetId);
          const rect = this.rect(sheet, body.range as Obj);
          // Merging what is already merged the same way changes nothing
          sheet.merges = sheet.merges.filter((m) => m[2] < rect[0] || m[0] > rect[2] || m[3] < rect[1] || m[1] > rect[3]);
          sheet.merges.push(rect);
          break;
        }
        case "updateDimensionProperties": {
          const range = body.range as Obj;
          const sheet = this.sheet(range.sheetId);
          const rows = range.dimension === "ROWS";
          const props = body.properties as Obj;
          const end = Number(range.endIndex);
          if (end > (rows ? sheet.rowCount : sheet.colCount)) throw Object.assign(new Error("Invalid requests: dimension outside the grid"), { code: 400 });
          for (let i = Number(range.startIndex ?? 0); i < end; i++) {
            for (const f of String(body.fields).split(",")) {
              if (f === "pixelSize") (rows ? sheet.rowPx : sheet.colPx).set(i, Number(props.pixelSize));
              else if (f === "hiddenByUser") { const set = rows ? sheet.hiddenRows : sheet.hiddenCols; if (props.hiddenByUser) set.add(i); else set.delete(i); }
              else throw new Error(`stub: unknown dimension field ${f}`);
            }
          }
          break;
        }
        case "addNamedRange": {
          const n = body.namedRange as Obj;
          const id = String(n.namedRangeId);
          if (this.namedRanges.has(id)) throw Object.assign(new Error("Invalid requests: a named range with that id already exists"), { code: 400 });
          this.sheet((n.range as Obj).sheetId);
          this.namedRanges.set(id, { name: String(n.name), range: structuredClone(n.range) as Obj });
          break;
        }
        case "setDataValidation": {
          const sheet = this.sheet((body.range as Obj).sheetId);
          const rect = this.rect(sheet, body.range as Obj);
          sheet.validations = sheet.validations.filter((v) => v.rect.join() !== rect.join());
          sheet.validations.push({ rect, rule: structuredClone(body.rule) });
          break;
        }
        case "addConditionalFormatRule": {
          const rule = body.rule as Obj;
          const sheet = this.sheet(((rule.ranges as Obj[])[0]).sheetId);
          sheet.conditional.splice(Number(body.index ?? sheet.conditional.length), 0, structuredClone(rule));
          break;
        }
        default: throw new Error(`stub: unknown request ${kind}`);
      }
    }
  }

  /** What a runner's check reads (see steps.ts) */
  existing() {
    return {
      sheetIds: new Set(this.sheets.keys()),
      namedRangeIds: new Set(this.namedRanges.keys()),
      conditionalRules: new Map(Array.from(this.sheets.values()).map((s) => [s.id, s.conditional.length])),
    };
  }
}
