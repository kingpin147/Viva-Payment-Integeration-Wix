import { webMethod, Permissions } from 'wix-web-module';
import wixData from 'wix-data';


const elevatedGetOrder = elevate(orders.getOrder);

export const getOrder = webMethod(
  Permissions.Anyone,
  async (identifiers, options) => {
    try {
      // Log the start of the getOrder process
      await wixData.insert('logs', {
        phase: 'get_order_start',
        data: { identifiers, options },
        ts: new Date().toISOString()
      });

      const result = await elevatedGetOrder(identifiers, options);

      // Log the raw result for debugging
      await wixData.insert('logs', {
        phase: 'get_order_raw_result',
        data: { result },
        ts: new Date().toISOString()
      });

      // Validate result structure and extract tickets
      let ticketsSource;
      if (result && result.tickets && Array.isArray(result.tickets)) {
        ticketsSource = result.tickets;
      } else {
        throw new Error('Invalid getOrder response: no tickets found');
      }

      // Log successful order retrieval
      await wixData.insert('logs', {
        phase: 'get_order_success',
        data: {
          orderNumber: identifiers.orderNumber || options.orderNumber,
          eventId: result.eventId,
          ticketsQuantity: result.ticketsQuantity,
          status: result.status
        },
        ts: new Date().toISOString()
      });

      // Extract and format ticket data
      const ticketData = ticketsSource.map(ticket => ({
        _id: ticket.ticketNumber || '',
        ticketName: ticket.name || 'Unknown',
        ticketPrice: ticket.price && ticket.price.currency && ticket.price.amount ? `${ticket.price.currency} ${ticket.price.amount}` : 'N/A',
        pdfUrl: ticket.ticketPdfUrl || ''
      }));

      if (!ticketData.length) {
        throw new Error('No tickets found in getOrder response');
      }

      return ticketData;
    } catch (error) {
      // Log error, with specific handling for database-related errors
      const errorData = {
        phase: 'get_order_error',
        data: {
          identifiers,
          options,
          errorMessage: error.message,
          errorStack: error.stack
        },
        ts: new Date().toISOString()
      };

      // Check if error is related to database name
      if (error.message.includes('database') || error.message.includes('collection')) {
        errorData.data.errorType = 'database_name_error';
      }

      await wixData.insert('logs', errorData);

      console.error('Get order error:', error);
      throw error; // Re-throw to ensure caller handles the error
    }
  },
);




const elevatedConfirmOrder = elevate(orders.confirmOrder);

export const confirmOrder = webMethod(
  Permissions.Anyone,
  async (eventId, options) => {
    try {
      // Log the start of the confirmOrder process
      await wixData.insert('logs', {
        phase: 'confirm_order_start',
        data: { eventId, options },
        ts: new Date().toISOString()
      });

      const result = await elevatedConfirmOrder(eventId, options);

      // Log the raw result for debugging
      await wixData.insert('logs', {
        phase: 'confirm_order_raw_result',
        data: { result },
        ts: new Date().toISOString()
      });

      // Handle result structure (object with orders array)
      let ticketsSource;
      if (result && result.orders && Array.isArray(result.orders) && result.orders.length > 0 && result.orders[0].tickets) {
        ticketsSource = result.orders[0].tickets;
      } else {
        throw new Error('Invalid confirmOrder response: no tickets found in orders');
      }

      // Log successful order confirmation
      await wixData.insert('logs', {
        phase: 'confirm_order_success',
        data: {
          eventId,
          orderNumber: options.orderNumber,
          result: {
            orderNumber: result.orders[0]?.orderNumber,
            eventId: result.orders[0]?.eventId,
            ticketsQuantity: result.orders[0]?.ticketsQuantity,
            status: result.orders[0]?.status
          }
        },
        ts: new Date().toISOString()
      });

      // Extract and format ticket data
      const ticketData = ticketsSource.map(ticket => ({
        _id: ticket.ticketNumber || '',
        ticketName: ticket.name || 'Unknown',
        ticketPrice: ticket.price && ticket.price.currency && ticket.price.amount ? `${ticket.price.currency} ${ticket.price.amount}` : 'N/A',
        pdfUrl: ticket.ticketPdfUrl || ''
      }));

      if (!ticketData.length) {
        throw new Error('No tickets found in confirmOrder response');
      }

      return ticketData;
    } catch (error) {
      // Log error, with specific handling for database-related errors
      const errorData = {
        phase: 'confirm_order_error',
        data: {
          eventId,
          options,
          errorMessage: error.message,
          errorStack: error.stack
        },
        ts: new Date().toISOString()
      };

      // Check if error is related to database name
      if (error.message.includes('database') || error.message.includes('collection')) {
        errorData.data.errorType = 'database_name_error';
      }

      await wixData.insert('logs', errorData);

      console.error('Confirm order error:', error);
      throw error; // Re-throw to ensure caller handles the error
    }
  },
);