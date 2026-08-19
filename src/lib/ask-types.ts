/** One turn of an Ask Arcadia conversation. */
export interface ChatTurn {
  role: "user" | "arcadia";
  content: string;
}
