/** Same shape as a Persian message tree, with every leaf widened to `string`. */
export type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
