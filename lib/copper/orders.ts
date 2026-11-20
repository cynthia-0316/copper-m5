// The customer's orders and the refund rule (Module 4). The rule is code, not
// the model: the app compares the order amount with the auto-refund limit. At
// or under it, the refund goes through; over it, it waits for a person on the
// Refund Console. The model can't argue past it.
// The Refund Console keeps the limit and every refund so far in the browser
// and sends them with each chat message (the "desk"), so nothing is stored on
// the server.
import { formatUsd } from "@/lib/copper/catalog";
import data from "@/lib/copper/data/orders.json";

export type Order = (typeof data.orders)[number];

/** A refund the app decided ("auto") or a supervisor decided. */
export type Refund = {
  orderId: string;
  item: string;
  amountUsd: number;
  status: "refunded" | "waiting" | "rejected";
  by: "auto" | "supervisor";
};

/** What the Refund Console sends with each chat message. */
export type Desk = { limitUsd: number; refunds: Refund[] };

export const CUSTOMER = data.customer;

/** The starting auto-refund limit on the Refund Console. */
export const DEFAULT_LIMIT_USD = 50;

export function getOrders(): Order[] {
  return structuredClone(data.orders);
}

/** get_orders: the customer's orders, each with its refund so far. */
export function ordersWithRefunds(desk: Desk) {
  return {
    customer: CUSTOMER,
    orders: getOrders().map((order) => ({
      id: order.id,
      item: order.item,
      amountUsd: order.amountUsd,
      date: order.date,
      refund:
        desk.refunds.find((r) => r.orderId === order.id)?.status ?? "none",
    })),
  };
}

export type RefundResult =
  | { status: "not_found"; orderId: string }
  | {
      /** Already refunded, waiting or rejected: nothing new happens. */
      status: Refund["status"];
      orderId: string;
      item: string;
      amountUsd: number;
    }
  | {
      /** refunded: paid now. needs_approval: waits for a supervisor. */
      status: "refunded" | "needs_approval";
      orderId: string;
      item: string;
      amountUsd: number;
      limitUsd: number;
    };

/** request_refund: the app's decision. At or under the limit, it's refunded. */
export function requestRefund(orderId: string, desk: Desk): RefundResult {
  const id = orderId.replace(/^#/, "").trim();
  const order = getOrders().find((o) => o.id === id);
  if (!order) return { status: "not_found", orderId: id };
  const { item, amountUsd } = order;
  const earlier = desk.refunds.find((r) => r.orderId === id);
  if (earlier) return { status: earlier.status, orderId: id, item, amountUsd };
  return {
    status: amountUsd <= desk.limitUsd ? "refunded" : "needs_approval",
    orderId: id,
    item,
    amountUsd,
    limitUsd: desk.limitUsd,
  };
}

/**
 * The Refund Console's list of refunds after the app decided one in the chat.
 * Only "refunded" and "needs_approval" add a refund (as refunded or waiting);
 * an order already on the list is never added twice.
 */
export function withDecision(
  refunds: Refund[],
  result: RefundResult,
): Refund[] {
  if (result.status !== "refunded" && result.status !== "needs_approval")
    return refunds;
  const { orderId, item, amountUsd } = result;
  const status = result.status === "refunded" ? "refunded" : "waiting";
  return refunds.some((r) => r.orderId === orderId)
    ? refunds
    : [...refunds, { orderId, item, amountUsd, status, by: "auto" }];
}

/**
 * A supervisor approves or rejects a waiting refund on the Refund Console:
 * the new list of refunds, and the [Refund Console] note the chat sends to the
 * Refund agent. Returns undefined when that refund isn't waiting.
 */
export function supervisorDecision(
  refunds: Refund[],
  refund: Refund,
  approve: boolean,
): { refunds: Refund[]; note: string } | undefined {
  if (!refunds.some((r) => r === refund && r.status === "waiting"))
    return undefined;
  return {
    refunds: refunds.map((r) =>
      r === refund
        ? { ...r, status: approve ? "refunded" : "rejected", by: "supervisor" }
        : r,
    ),
    note: `[Refund Console] A supervisor ${approve ? "approved" : "rejected"} the ${formatUsd(refund.amountUsd)} refund for order #${refund.orderId} (${refund.item}).${approve ? " It has been refunded." : " It will not be refunded."}`,
  };
}
