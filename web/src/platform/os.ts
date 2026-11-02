export const tmpdir = () => "/tmp";

// Solver instances are expensive; interface checks stay serial in the browser.
export const availableParallelism = () => 1;
