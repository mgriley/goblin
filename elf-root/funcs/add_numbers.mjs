export async function handle(input, libs) {
  const { a, b } = input;
  const result = libs.math_ops.multiply(a, b);
  await sys.call("db_set", { key: "math/lastresult", value: String(result) });
  return { result };
}
