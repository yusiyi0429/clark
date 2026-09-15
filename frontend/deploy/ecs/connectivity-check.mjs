const checks = await Promise.all([
  fetch(`${process.env.ARK_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}` },
  }).then((response) => ["ark", response.status]),
  fetch(`${process.env.TKOS_ONTOLOGY_BASE_URL}/health`).then((response) => [
    "ontology",
    response.status,
  ]),
]);

console.log(JSON.stringify(checks));

if (checks.some(([, status]) => status < 200 || status >= 500)) {
  process.exitCode = 1;
}
