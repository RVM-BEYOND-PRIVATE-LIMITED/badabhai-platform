// TEMPORARY (#718): a deliberate analyzer error, to prove `ci-required` can now go RED
// on a broken Flutter app. Removed in the very next commit on this branch — the issue
// asks for evidence, and the whole point of #718 is that a green check was not evidence.
int probe() => 'this is not an int';
