import { getVivaCheckoutUrl } from "backend/viva";
import wixData from 'wix-data';

/** Helpers */
const toTwoDecimals = (n) => Number(n).toFixed(2);
const centsToDecimal = (v) => {
    if (v == null || v === '') return null;
    const str = String(v).trim();
    if (/^\d+$/.test(str)) return toTwoDecimals(Number(str) / 100); // cents
    if (/^\d+(\.\d{1,2})$/.test(str)) return toTwoDecimals(Number(str)); // already decimal
    return null;
};

const safeStr = (v) => (v == null ? '' : String(v));
const buildDescription = (order) => {
    const descFromOrder = order?.description?.text || order?.description?.title || '';
    if (descFromOrder) return safeStr(descFromOrder).slice(0, 150);
    const items = order?.description?.items || [];
    const names = items.map(i => safeStr(i?.name)).filter(Boolean);
    return names.join(', ').trim() || 'Order Payment';
};

export const connectAccount = async (options, context) => {
    const { credentials } = options;
    return { credentials };
};

export const createTransaction = async (options, context) => {
    const { merchantCredentials, order, wixTransactionId } = options || {};
    await wixData.insert('logs', {
        phase: 'Viva Payment started',
        data: { "Payment Started": order },
        timestamp: new Date().toISOString()
    });

    const cleanDescription = (desc) => {
        if (!desc) return 'Order Payment';
        return desc
            .replace(/<[^>]+>/g, '')
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .substring(0, 20)
            .trim();
    };
    const isValidUUID = (id) => {
        const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        return regex.test(id);
    };

    const rawTotal = order?.totalAmount ?? order?.description?.totalAmount;
    const amount = centsToDecimal(rawTotal);
    const shortId = order._id;
    const description = cleanDescription(buildDescription(order));
    const email = order?.description?.billingAddress?.email || "customer@example.com";
    const itemsRaw = Array.isArray(order?.description?.items) ? order.description.items : [];

    const items = itemsRaw.filter(item => item._id && isValidUUID(item._id));
    await wixData.insert('logs', {
        phase: 'items_filtered',
        data: { filteredItems: items.map(item => item._id), count: items.length },
        timestamp: new Date().toISOString()
    });

    if (items.length === 0) {
        await wixData.insert('logs', {
            phase: 'error',
            data: { message: 'No valid ticket items found' },
            timestamp: new Date().toISOString()
        });
        return { code: 'NO_VALID_ITEMS', message: 'No valid ticket items found' };
    }

    const itemIds = items.map(item => item._id);
    await wixData.insert('logs', {
        phase: 'ticket_query_start',
        data: { itemIds },
        timestamp: new Date().toISOString()
    });

    const results = await wixData.query("Events/Tickets").hasSome("_id", itemIds).find();
    const ticketsMap = new Map(results.items.map(ticket => [ticket._id, ticket]));
    await wixData.insert('logs', {
        phase: 'ticket_query_complete',
        data: { foundTickets: results.items.length, itemIds },
        timestamp: new Date().toISOString()
    });

    const tickets = [];
    for (let item of items) {
        try {
            const ticket = ticketsMap.get(item._id);
            if (ticket) {
                tickets.push(ticket);
            } else {
                throw new Error(`No ticket found for itemId: ${item._id}`);
            }
        } catch (e) {
            await wixData.insert('logs', {
                phase: 'ticket_error',
                data: { itemId: item._id, msg: e.message, stack: e.stack },
                timestamp: new Date().toISOString()
            });
            console.error(`Error processing ticket for itemId: ${item._id}`, e);
        }
    }

    if (tickets.length === 0) {
        await wixData.insert('logs', {
            phase: 'error',
            data: { message: 'No valid tickets found' },
            timestamp: new Date().toISOString()
        });
        return { code: 'NO_VALID_TICKETS', message: 'No valid tickets found' };
    }

    const eventIds = new Set(tickets.map(ticket => ticket.event));
    if (eventIds.size > 1) {
        return { code: 'MULTIPLE_EVENTS', message: 'All tickets must belong to the same event' };
    }
    const eventId = eventIds.values().next().value;

    // Combine orderId and eventId in merchantTrns
    const merchantTrns = `${shortId}:${eventId}`;

    const paymentData = {
        amount: Number(amount) * 100, // Convert to cents
        customerTrns: description,
        customer: {
            email: email,
            countryCode: "pt",
            requestLang: "en-US"
        },
        sourceCode: "9393",
        merchantTrns: merchantTrns, // Use combined orderId:eventId
    };

    const paymentUrl = await getVivaCheckoutUrl(paymentData);
    await wixData.insert('logs', {
        phase: 'Viva Payment Url',
        data: { "Payment Url": paymentUrl },
        timestamp: new Date().toISOString()
    });

    return {
        redirectUrl: paymentUrl,
    };
};

export const refundTransaction = async (options, context) => {};