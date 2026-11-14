"use strict";

import { XMLParser, XMLValidator } from "../src/fxp.js";

/**
 * Cross-entry contract for processing instruction (PI) position rules.
 *
 * The ingestion pre-storage validation layer (XMLValidator) and the
 * downstream structured parsing layer (XMLParser) must apply the same
 * position rules to the same payload:
 *   - a well-formed PI, in the prolog or inside element content, is accepted
 *     by both entries;
 *   - an unclosed PI (missing the closing '?>') is rejected by both entries,
 *     with the validator pointing at the PI's position and naming its target;
 *   - an 'xml' declaration placed anywhere except the document start is
 *     rejected by the validator.
 */
describe("Processing instruction position rules across both entries", function () {

  //position shapes that must stay valid — these back the existing legal
  //sample artifacts and must never regress
  const validSamples = [
    ["document start declaration", '<?xml version="1.0"?><root/>'],
    ["declaration with BOM", "﻿<?xml version=\"1.0\"?><root/>"],
    ["prolog PI before root", '<?xml version="1.0"?><?mso-contentType?><root></root>'],
    ["PI inside element text", "<h1><?mso?> abc</h1>"],
    ["multiline PI inside element", "<?xml version=\"1.0\"?>\n<content><?tibcochar ?> something</content>"],
    ["top level PI after root close", '<?xml version="1.0"?><root></root><?mso-contentType something="val"?>'],
    ["PI with quoted value containing '>'", '<?xml version="1.0"?><root><?pi a="a>b"?></root>'],
  ];

  validSamples.forEach(([label, xml]) => {
    it(`accepts a legal PI (${label}) via XMLValidator`, function () {
      expect(XMLValidator.validate(xml)).toBe(true);
    });

    it(`accepts a legal PI (${label}) via XMLParser with validation`, function () {
      const parser = new XMLParser();
      expect(() => parser.parse(xml, true)).not.toThrow();
    });
  });

  //unclosed PIs across every position shape: both entries must reject them
  const unclosedSamples = [
    {
      label: "unclosed PI inside element content",
      xml: "<root><?pi some text</root>",
      line: 1, col: 9, target: "pi"
    },
    {
      label: "unclosed PI in element text area",
      xml: "<root>text<?pi bad</root>",
      line: 1, col: 13, target: "pi"
    },
    {
      label: "unclosed PI at top level after a self closing tag",
      xml: "<root/><?pi text",
      line: 1, col: 10, target: "pi"
    },
    {
      label: "unclosed PI at top level after root close",
      xml: "<root></root><?pi text",
      line: 1, col: 16, target: "pi"
    },
    {
      label: "unclosed PI at document start",
      xml: '<?xml version="1.0" <root/>',
      line: 1, col: 3, target: "xml"
    },
    {
      label: "unclosed PI without any root node",
      xml: "<?pi",
      line: 1, col: 3, target: "pi"
    },
    {
      label: "unclosed PI reported with its line number",
      xml: "<root>\n  <child/>\n  <?pi broken\n</root>",
      line: 3, col: 5, target: "pi"
    },
  ];

  unclosedSamples.forEach(({ label, xml, line, col, target }) => {
    it(`rejects an ${label} via XMLValidator with position and content`, function () {
      const result = XMLValidator.validate(xml);
      expect(result.err).toBeDefined();
      expect(result.err.code).toBe("InvalidXml");
      expect(result.err.msg).toBe(`Pi Tag '${target}' is not closed.`);
      expect(result.err.line).toBe(line);
      expect(result.err.col).toBe(col);
    });

    it(`rejects an ${label} via XMLParser validation gate`, function () {
      const parser = new XMLParser();
      //the parse() entry surfaces the validator error message and position
      expect(() => parser.parse(xml, true)).toThrowError(
        `Pi Tag '${target}' is not closed.:${line}:${col}`
      );
    });

    it(`rejects an ${label} via the XMLParser parsing layer itself`, function () {
      const parser = new XMLParser();
      //without the validation gate the parser independently detects the
      //same malformed payload — the two entries share one position rule
      expect(() => parser.parse(xml)).toThrowError("Pi Tag is not closed.");
    });
  });

  //misplaced XML declarations: legal only at the document start
  const misplacedDeclarationSamples = [
    { label: "declaration inside element", xml: '<root><?xml version="1.0"?></root>', line: 1, col: 9 },
    { label: "declaration at top level after root", xml: '<root/><?xml version="1.0"?>', line: 1, col: 10 },
    { label: "declaration without attributes inside element", xml: "<root><?xml?></root>", line: 1, col: 9 },
    {
      label: "declaration on a later line",
      xml: "<root>\n<?xml version=\"1.0\"?>\n</root>",
      line: 2, col: 3
    },
  ];

  misplacedDeclarationSamples.forEach(({ label, xml, line, col }) => {
    it(`rejects a misplaced XML declaration (${label}) via XMLValidator`, function () {
      const result = XMLValidator.validate(xml);
      expect(result.err).toBeDefined();
      expect(result.err.code).toBe("InvalidXml");
      expect(result.err.msg).toBe("XML declaration allowed only at the start of the document.");
      expect(result.err.line).toBe(line);
      expect(result.err.col).toBe(col);
    });

    it(`blocks a misplaced XML declaration (${label}) at the XMLParser validation gate`, function () {
      const parser = new XMLParser();
      expect(() => parser.parse(xml, true)).toThrowError(
        `XML declaration allowed only at the start of the document.:${line}:${col}`
      );
    });
  });

  it("keeps the document-start declaration valid even with leading whitespace-free BOM", function () {
    expect(XMLValidator.validate("﻿<?xml version=\"1.0\" standalone=\"yes\" ?><foo>x</foo>")).toBe(true);
  });

  it("still rejects a declaration that is not at the start when a BOM is present", function () {
    const result = XMLValidator.validate("﻿<root/><?xml?>");
    expect(result.err).toBeDefined();
    expect(result.err.msg).toBe("XML declaration allowed only at the start of the document.");
    expect(result.err.line).toBe(1);
    expect(result.err.col).toBe(10);
  });
});
