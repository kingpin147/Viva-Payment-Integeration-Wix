import { ok, badRequest, serverError } from 'wix-http-functions';
import { getSecret } from 'wix-secrets-backend';
import { confirmOrder, getOrder } from 'backend/getEvent.web';
import wixData from 'wix-data';
import { sendTicketEmail } from 'backend/email.web';
import { getVivaWebhookKey } from 'backend/viva.jsw';

async function isPermitted(headers, query, body) {
    try {
        const sharedAuthKey = await getSecret('vivaWebhookSecret');
        console.log('Retrieved vivaWebhookSecret:', sharedAuthKey ? 'Set' : 'Not set');

        // Log all headers, query parameters, and body for debugging
        console.log('Request headers:', JSON.stringify(headers, null, 2));
        console.log('Query parameters:', JSON.stringify(query, null, 2));
        console.log('Request body:', JSON.stringify(body, null, 2));

        // Normalize header names to lowercase for case-insensitive matching
        const normalizedHeaders = Object.keys(headers).reduce((acc, key) => {
            acc[key.toLowerCase()] = headers[key];
            return acc;
        }, {});

        const authHeader = normalizedHeaders['authorization'] || normalizedHeaders['x-api-key'] || normalizedHeaders['x-viva-signature'];
        const authQuery = query && query.auth;

        // If no authentication headers or query parameters are present, log and proceed
        if (!authHeader && !authQuery) {
            console.warn('No authorization header or query parameter provided; proceeding without authentication');
            return true; // Temporarily bypass authentication
        }

        if (authHeader) {
            if (authHeader.toLowerCase().startsWith('bearer ')) {
                const token = authHeader.substring(7).trim();
                console.log('Bearer token:', token);
                return token === sharedAuthKey;
            }
            console.log('Direct auth header:', authHeader);
            return authHeader === sharedAuthKey;
        }

        if (authQuery) {
            console.log('Auth query parameter:', authQuery);
            return authQuery === sharedAuthKey;
        }

        return false;
    } catch (err) {
        console.error('Error validating authorization:', err);
        return false;
    }
}

export async function get_transactionPaymentCreated(request) {
    try {
        const webhookKey = await getVivaWebhookKey();
        
        if (!webhookKey) {
            console.error('Failed to retrieve webhook key');
            return badRequest({
                body: { error: 'Failed to generate webhook key' },
                headers: { 'Content-Type': 'application/json' }
            });
        }
        console.log('Webhook verification key generated:', webhookKey);
        return ok({
            body: { Key: webhookKey },
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Error in webhook verification:', error);
        return serverError({
            body: { error: 'Internal server error during verification' },
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

export async function post_transactionPaymentCreated(request) {
    let webhookData;
    let downloadUrl;

    try {
        const headers = request.headers;
        const query = request.query;
        webhookData = await request.body.json();

        // Log raw request details for debugging
        console.log('Received webhook data:', JSON.stringify(webhookData, null, 2));

        // Temporarily bypass authentication for testing
        // if (!(await isPermitted(headers, query, webhookData))) {
        //     console.error('Unauthorized webhook request', { headers, query });
        //     return badRequest({
        //         body: { error: 'Unauthorized' },
        //         headers: { 'Content-Type': 'application/json' }
        //     });
        // }

        await wixData.insert('logs', {
            phase: 'webhook_data',
            data: { webhookData },
            ts: new Date().toISOString()
        });

        const safeGet = (obj, path, defaultValue = null) => {
            try {
                return path.reduce((current, key) => current?.[key], obj) ?? defaultValue;
            } catch {
                return defaultValue;
            }
        };

        const eventTypeId = safeGet(webhookData, ['EventTypeId']);
        const orderCode = safeGet(webhookData, ['EventData', 'OrderCode']);
        const transactionId = safeGet(webhookData, ['EventData', 'TransactionId']);
        const statusId = safeGet(webhookData, ['EventData', 'StatusId']);
        const amount = safeGet(webhookData, ['EventData', 'Amount']);
        const fullName = safeGet(webhookData, ['EventData', 'fullName']);
        const merchantId = safeGet(webhookData, ['EventData', 'MerchantId']);
        const customerEmail = safeGet(webhookData, ['EventData', 'Email']);
        const customerTrns = safeGet(webhookData, ['EventData', 'CustomerTrns']);
        const merchantTrns = safeGet(webhookData, ['EventData', 'MerchantTrns']);
        const currencyCode = safeGet(webhookData, ['EventData', 'CurrencyCode']);
        const insDate = safeGet(webhookData, ['EventData', 'InsDate']);
        const cardNumber = safeGet(webhookData, ['EventData', 'CardNumber']);

        if (eventTypeId !== 1796) {
            console.error('Invalid webhook event type', { eventTypeId });
            return badRequest({
                body: { code: 'INVALID_EVENT_TYPE', message: 'Webhook event type is not Transaction Payment Created (1796)' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (!orderCode || !transactionId || !statusId || amount == null || !merchantTrns) {
            console.error('Missing required webhook fields', { orderCode, transactionId, statusId, amount, merchantTrns });
            return badRequest({
                body: { code: 'MISSING_FIELDS', message: 'Required fields (OrderCode, TransactionId, StatusId, Amount, MerchantTrns) are missing' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (statusId !== 'F') {
            console.error('Transaction not successful', { statusId });
            return badRequest({
                body: { code: 'TRANSACTION_NOT_SUCCESSFUL', message: `Transaction status is ${statusId}, expected 'F' for success` },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (typeof amount !== 'number' || amount <= 0) {
            console.error('Invalid amount', { amount });
            return badRequest({
                body: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive number' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Split merchantTrns into orderId and eventId
        const [orderId, eventId] = merchantTrns.split(':');
        if (!orderId || !eventId) {
            console.error('Invalid merchantTrns format', { merchantTrns });
            await wixData.insert('logs', {
                phase: 'webhook_processing_error',
                data: { errorMessage: 'Invalid merchantTrns format, expected orderId:eventId', merchantTrns },
                ts: new Date().toISOString()
            });
            return ok({
                body: { code: 'INVALID_MERCHANT_TRNS', message: 'Invalid merchantTrns format' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Validate eventId is a UUID
        const isValidUUID = (id) => {
            const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            return regex.test(id);
        };
        if (!isValidUUID(eventId)) {
            console.error('Invalid eventId format', { eventId });
            await wixData.insert('logs', {
                phase: 'webhook_processing_error',
                data: { errorMessage: 'eventId is not a valid UUID', eventId },
                ts: new Date().toISOString()
            });
            return ok({
                body: { code: 'INVALID_EVENT_ID', message: 'eventId is not a valid UUID' },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log('Processing successful transaction', {
            orderCode,
            transactionId,
            amount,
            currencyCode,
            customerEmail,
            merchantId,
            customerTrns,
            merchantTrns,
            orderId,
            eventId,
            insDate,
            cardNumber: cardNumber ? `****${cardNumber.slice(-4)}` : 'N/A'
        });

        // Update Wix order (confirmOrder)
        try {
            const options = { orderNumber: [orderId] }; // Corrected to orderNumber, kept as array per documentation
            console.log('Confirming order with options:', { eventId, options });
            const confirmResult = await confirmOrder(eventId, options);
            console.log('Order confirmed successfully', {
                orderId,
                eventId,
                confirmResult
            });

            await wixData.insert('logs', {
                phase: 'webhook_order_confirm',
                data: {
                    orderId,
                    eventId,
                    transactionId,
                    orderCode,
                    amount,
                    confirmResult
                },
                ts: new Date().toISOString()
            });
        } catch (confirmError) {
            console.error('Error confirming order in Wix:', {
                orderId,
                eventId,
                error: confirmError.message,
                stack: confirmError.stack,
                details: confirmError.details || {}
            });
            await wixData.insert('logs', {
                phase: 'webhook_order_confirm_error',
                data: {
                    orderId,
                    eventId,
                    transactionId,
                    orderCode,
                    errorMessage: confirmError.message,
                    stack: confirmError.stack,
                    details: confirmError.details || {}
                },
                ts: new Date().toISOString()
            });
            // Continue processing
        }

        // Get order details
        let getOrderResponse = null;
        const identifiers = {
            eventId: eventId,
            orderNumber: orderId // Corrected to orderNumber, changed to string per documentation
        };
        const options1 = {
            fieldset: ["TICKETS", "DETAILS"]
        };
        try {
            console.log('Fetching order with identifiers:', identifiers);
            getOrderResponse = await getOrder(identifiers, options1);
            const tickets = getOrderResponse;
            if (tickets.length === 0) {
                throw new Error("No tickets found in order.");
            }

            const firstTicket = tickets[0];
            downloadUrl = firstTicket.pdfUrl;
            if (!downloadUrl) {
                throw new Error("No valid ticket URL found (checkInUrl).");
            }
            await wixData.insert('logs', {
                phase: 'get_order_complete',
                data: { getOrderResponse },
                ts: new Date().toISOString()
            });
        } catch (getOrderError) {
            console.error('Get order failed:', {
                orderId,
                eventId,
                error: getOrderError.message,
                stack: getOrderError.stack,
                details: getOrderError.details || {}
            });
            await wixData.insert('logs', {
                phase: 'get_order_error',
                data: {
                    orderId,
                    eventId,
                    errorMessage: getOrderError.message,
                    stack: getOrderError.stack,
                    details: getOrderError.details || {}
                },
                ts: new Date().toISOString()
            });
            // Continue processing
        }

        // Send email if downloadUrl and customerEmail are available
        if (downloadUrl && customerEmail) {
            try {
                await sendTicketEmail(fullName || 'Customer New', customerEmail, downloadUrl);
                console.log('Ticket email sent successfully', { customerEmail, orderId });
                await wixData.insert('logs', {
                    phase: 'email_sent_success',
                    data: { customerEmail, orderId, downloadUrl },
                    ts: new Date().toISOString()
                });
            } catch (emailError) {
                console.error('Error sending ticket email:', {
                    customerEmail,
                    orderId,
                    error: emailError.message,
                    stack: emailError.stack
                });
                await wixData.insert('logs', {
                    phase: 'email_send_error',
                    data: {
                        customerEmail,
                        orderId,
                        errorMessage: emailError.message
                    },
                    ts: new Date().toISOString()
                });
            }
        } else {
            console.warn('Skipping email send: missing downloadUrl or customerEmail', { downloadUrl: !!downloadUrl, customerEmail });
            await wixData.insert('logs', {
                phase: 'email_skipped',
                data: { reason: 'missing downloadUrl or customerEmail', orderId },
                ts: new Date().toISOString()
            });
        }

        return ok({
            body: {
                code: 'SUCCESS',
                message: 'Transaction processed successfully',
                data: { orderCode, transactionId, amount, currencyCode, merchantId, orderId, eventId }
            },
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Error processing webhook', { error: error.message, stack: error.stack });
        await wixData.insert('logs', {
            phase: 'webhook_processing_error',
            data: {
                errorMessage: error.message,
                webhookData
            },
            ts: new Date().toISOString()
        });
        return ok({
            body: { code: 'ACKNOWLEDGED', message: 'Webhook received but processing failed internally' },
            headers: { 'Content-Type': 'application/json' }
        });
    }
}