// Charter — operator-authored ground truth.
//
// The charter is the small set of facts about the organisation that
// Arcadia treats as canonical: the people, the products, the
// vocabulary, the customers, the operating norms. It overrides
// inferred memory at recall time, so the operator can correct
// Arcadia simply by editing the charter.

export interface CharterRecord {
  id: string;
  version: number;
  body: string;
  active: boolean;
  replacesId?: string;
  createdAt: string;
}
