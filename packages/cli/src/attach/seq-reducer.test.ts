import { describe, expect, it } from "vitest";

import { SeqReducer } from "./seq-reducer.js";

describe("SeqReducer", () => {
  it("ignores output until a snapshot binds the sequence", () => {
    const reducer = new SeqReducer();
    expect(reducer.hasSnapshot).toBe(false);
    expect(reducer.classify(0)).toBe("ignore");
    expect(reducer.lastSeq).toBeNull();
  });

  it("accepts exactly the next sequence after a snapshot", () => {
    const reducer = new SeqReducer();
    reducer.applySnapshot(5);
    expect(reducer.classify(5)).toBe("ignore");
    expect(reducer.classify(4)).toBe("ignore");
    expect(reducer.classify(6)).toBe("apply");
    expect(reducer.lastSeq).toBe(6);
    expect(reducer.classify(7)).toBe("apply");
    expect(reducer.lastSeq).toBe(7);
  });

  it("reports forward gaps without advancing", () => {
    const reducer = new SeqReducer();
    reducer.applySnapshot(10);
    expect(reducer.classify(12)).toBe("gap");
    expect(reducer.lastSeq).toBe(10);
    expect(reducer.classify(11)).toBe("apply");
  });

  it("reset makes output ignored until the next snapshot", () => {
    const reducer = new SeqReducer();
    reducer.applySnapshot(3);
    reducer.reset();
    expect(reducer.hasSnapshot).toBe(false);
    expect(reducer.classify(4)).toBe("ignore");
    reducer.applySnapshot(20);
    expect(reducer.classify(21)).toBe("apply");
  });
});
