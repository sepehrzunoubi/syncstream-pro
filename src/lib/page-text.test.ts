import { test } from "node:test";
import assert from "node:assert/strict";
import { pageStartOffsets } from "./page-offsets";

test("each PDF page's first body line finds where Docs starts the page", () => {
  const body = "Rogo KPI Analysis\nSepehr Zunoubi | October 9 2026\nRogo is an AI assistant for investment banks. The primary purpose of this tool is to allow employees to perform research.\nThe team behind Rogo's focus on addressing repetitive tasks stems from the founders.\nSince Rogo interfaces directly with an organization's internal databases, it is likely that users begin relying heavily on Rogo.\nSources\nAWS Rogo case study";
  const pages = [
    "Running head\nRogo KPI Analysis\nSepehr Zunoubi | October 9 2026\nRogo is an AI assistant for investment banks. The primary purpose of this tool is to allow\nemployees to perform research.\n1\n",
    "Running head\nThe team behind Rogo's focus on addressing repetitive tasks stems from the founders.\nSince Rogo interfaces directly with an organization's\n2\n",
    "Running head\ninternal databases, it is likely that users begin relying heavily on Rogo.\nSources\nAWS Rogo case study\n3\n",
  ];
  const offsets = pageStartOffsets(body, pages);
  assert.equal(offsets.length, 2);
  assert.equal(body.slice(offsets[0]!, offsets[0]! + 8), "The team");
  assert.equal(body.slice(offsets[1]!, offsets[1]! + 8), "internal");
  // A page whose lines are not in the body (only a footer) can't be placed
  assert.deepEqual(pageStartOffsets(body, ["a", "Running head\n9\n"]), [null]);
});
