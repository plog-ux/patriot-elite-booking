// ═══════════════════════════════════════════════════════════════════
// Patriot Elite Logistics — Unified Booking Server
// ═══════════════════════════════════════════════════════════════════
// This single server does everything:
//   - Serves the booking website (public/index.html)
//   - Handles card payments via Square
//   - Creates and sends Square invoices
//   - Manages customer records in Square
//
// Deploy to Railway, Render, or any Node.js host.
// ═══════════════════════════════════════════════════════════════════

require('dotenv').config();
const path     = require('path');
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, Environment } = require('square');

// ── Square client ──────────────────────────────────────────────
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? Environment.Production
    : Environment.Sandbox,
});

const paymentsApi  = squareClient.paymentsApi;
const invoicesApi  = squareClient.invoicesApi;
const ordersApi    = squareClient.ordersApi;
const customersApi = squareClient.customersApi;
const catalogApi   = squareClient.catalogApi;

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

// ── Express app ────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve the booking website from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'patriot-elite-booking' });
});


// ═══════════════════════════════════════════════════════════════
// GET /api/services
// Fetch services from your Square Catalog so the booking page
// always shows your current offerings and prices.
// ═══════════════════════════════════════════════════════════════
app.get('/api/services', async (_req, res) => {
  try {
    // Fetch all active ITEM types from the Square catalog
    const result = await catalogApi.listCatalog(undefined, 'ITEM');
    const items = result.result.objects || [];

    // Map Square catalog items into a clean format for the frontend
    const services = items
      .filter(item => {
        // Only include items that are present at this location
        const data = item.itemData;
        if (!data) return false;
        // Skip archived/deleted items
        if (item.isDeleted) return false;
        return true;
      })
      .map(item => {
        const data = item.itemData;
        const variation = data.variations && data.variations[0];
        const priceMoney = variation?.itemVariationData?.priceMoney;

        // Price in cents → dollars
        let priceCents = null;
        let priceDisplay = 'Custom Quote';
        let pricePerUnit = '';

        if (priceMoney && priceMoney.amount) {
          priceCents = Number(priceMoney.amount);
          const dollars = priceCents / 100;
          priceDisplay = '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: dollars % 1 ? 2 : 0 });
        }

        return {
          id:           item.id,
          variationId:  variation?.id || null,
          name:         data.name || 'Service',
          description:  data.description || '',
          priceCents:   priceCents,
          priceDisplay: priceDisplay,
          pricePerUnit: pricePerUnit,
        };
      });

    res.json({ success: true, services });

  } catch (error) {
    console.error('Catalog API error:', JSON.stringify(error.result || error.message, null, 2));
    res.status(500).json({
      success: false,
      error:   'Failed to load services from Square.',
      detail:  error.result?.errors || error.message,
    });
  }
});


// ═══════════════════════════════════════════════════════════════
// POST /api/customer
// Create or update a customer record in Square.
// ═══════════════════════════════════════════════════════════════
app.post('/api/customer', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone,
      homeAddress, workAddress, preferences,
      isVeteran, isNonprofit,
    } = req.body;

    // Check if a customer with this email already exists
    let existingCustomer = null;
    try {
      const searchResult = await customersApi.searchCustomers({
        query: {
          filter: {
            emailAddress: { exact: email },
          },
        },
      });
      if (searchResult.result.customers && searchResult.result.customers.length > 0) {
        existingCustomer = searchResult.result.customers[0];
      }
    } catch (_) {
      // No match found — we'll create a new one
    }

    // Build the note field with profile data
    const noteLines = [];
    if (homeAddress)  noteLines.push(`Home: ${homeAddress}`);
    if (workAddress)  noteLines.push(`Work: ${workAddress}`);
    if (preferences)  noteLines.push(`Preferences: ${preferences}`);
    if (isVeteran)    noteLines.push('Status: Veteran/First Responder (10% discount)');
    if (isNonprofit)  noteLines.push('Status: Non-profit/Volunteer (10% discount)');
    const note = noteLines.join('\n');

    let customer;

    if (existingCustomer) {
      const updateResult = await customersApi.updateCustomer(existingCustomer.id, {
        givenName:    firstName,
        familyName:   lastName,
        emailAddress: email,
        phoneNumber:  phone || undefined,
        note:         note || undefined,
      });
      customer = updateResult.result.customer;
    } else {
      const createResult = await customersApi.createCustomer({
        idempotencyKey: uuidv4(),
        givenName:      firstName,
        familyName:     lastName,
        emailAddress:   email,
        phoneNumber:    phone || undefined,
        note:           note || undefined,
        referenceId:    isVeteran ? 'VETERAN_DISCOUNT' : isNonprofit ? 'NONPROFIT_DISCOUNT' : undefined,
      });
      customer = createResult.result.customer;
    }

    res.json({
      success:    true,
      customerId: customer.id,
      isNew:      !existingCustomer,
    });

  } catch (error) {
    console.error('Customer API error:', JSON.stringify(error.result || error.message, null, 2));
    res.status(500).json({
      success: false,
      error:   'Failed to create/update customer record.',
      detail:  error.result?.errors || error.message,
    });
  }
});


// ═══════════════════════════════════════════════════════════════
// POST /api/pay
// Process a card payment using the nonce from Square Web
// Payments SDK on the frontend.
// ═══════════════════════════════════════════════════════════════
app.post('/api/pay', async (req, res) => {
  try {
    const { sourceId, amountCents, customerId, booking } = req.body;

    if (!sourceId || !amountCents) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceId and amountCents.',
      });
    }

    const bookingNote = booking
      ? `${booking.service} | ${booking.date} ${booking.time} | ${booking.pickup} → ${booking.dropoff} | ${booking.passengers} pax`
      : 'Patriot Elite Logistics booking';

    const paymentResult = await paymentsApi.createPayment({
      idempotencyKey: uuidv4(),
      sourceId:       sourceId,
      amountMoney: {
        amount:   BigInt(amountCents),
        currency: 'USD',
      },
      locationId:  LOCATION_ID,
      customerId:  customerId || undefined,
      note:        bookingNote,
      referenceId: 'PEL-' + Date.now().toString(36).toUpperCase(),
    });

    const payment = paymentResult.result.payment;

    res.json({
      success:        true,
      paymentId:      payment.id,
      status:         payment.status,
      receiptUrl:     payment.receiptUrl,
      confirmationId: payment.referenceId,
    });

  } catch (error) {
    console.error('Payment API error:', JSON.stringify(error.result || error.message, null, 2));
    res.status(500).json({
      success: false,
      error:   'Payment processing failed.',
      detail:  error.result?.errors || error.message,
    });
  }
});


// ═══════════════════════════════════════════════════════════════
// POST /api/invoice
// Create a Square order + invoice, then send it to the
// customer's email.
// ═══════════════════════════════════════════════════════════════
app.post('/api/invoice', async (req, res) => {
  try {
    const { customerId, amountCents, serviceName, booking, email } = req.body;

    if (!customerId || !email) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: customerId and email.',
      });
    }

    const bookingDescription = booking
      ? `${serviceName} — ${booking.date} at ${booking.time}\nPickup: ${booking.pickup}\nDropoff: ${booking.dropoff}\nPassengers: ${booking.passengers}`
      : serviceName;

    // Step 1: Create an order (invoices must be backed by an order)
    const orderResult = await ordersApi.createOrder({
      idempotencyKey: uuidv4(),
      order: {
        locationId: LOCATION_ID,
        customerId: customerId,
        lineItems: [
          {
            name:     serviceName || 'Transportation Service',
            quantity: '1',
            basePriceMoney: {
              amount:   BigInt(amountCents || 0),
              currency: 'USD',
            },
            note: bookingDescription,
          },
        ],
      },
    });

    const order = orderResult.result.order;

    // Step 2: Create the invoice
    const dueDate = booking?.date ? formatDueDate(booking.date) : formatDueDate(null);

    const invoiceResult = await invoicesApi.createInvoice({
      idempotencyKey: uuidv4(),
      invoice: {
        locationId:  LOCATION_ID,
        orderId:     order.id,
        title:       `Patriot Elite Logistics — ${serviceName}`,
        description: bookingDescription,
        primaryRecipient: {
          customerId: customerId,
        },
        paymentRequests: [
          {
            requestType:            'BALANCE',
            dueDate:                dueDate,
            automaticPaymentSource: 'NONE',
            reminders: [
              {
                relativeScheduledDays: -1,
                message: `Reminder: Your ${serviceName} booking is coming up. Please complete payment before your trip.`,
              },
            ],
          },
        ],
        acceptedPaymentMethods: {
          card:            true,
          bankAccount:     false,
          squareGiftCard:  false,
          buyNowPayLater:  false,
        },
        deliveryMethod: 'EMAIL',
      },
    });

    const invoice = invoiceResult.result.invoice;

    // Step 3: Publish (send) the invoice
    const publishResult = await invoicesApi.publishInvoice(invoice.id, {
      version:        invoice.version,
      idempotencyKey: uuidv4(),
    });

    const publishedInvoice = publishResult.result.invoice;

    res.json({
      success:        true,
      invoiceId:      publishedInvoice.id,
      invoiceNumber:  publishedInvoice.invoiceNumber,
      status:         publishedInvoice.status,
      publicUrl:      publishedInvoice.publicUrl,
      confirmationId: 'PEL-' + Date.now().toString(36).toUpperCase(),
    });

  } catch (error) {
    console.error('Invoice API error:', JSON.stringify(error.result || error.message, null, 2));
    res.status(500).json({
      success: false,
      error:   'Failed to create and send invoice.',
      detail:  error.result?.errors || error.message,
    });
  }
});


// ── Helpers ────────────────────────────────────────────────────
function formatDueDate(dateStr) {
  let d;
  if (dateStr) {
    d = new Date(dateStr);
    if (isNaN(d.getTime())) {
      d = new Date();
      d.setDate(d.getDate() + 7);
    }
  } else {
    d = new Date();
    d.setDate(d.getDate() + 7);
  }
  return d.toISOString().split('T')[0];
}

// Catch-all: serve the booking page for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ── Start server ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Patriot Elite Booking running on http://localhost:${PORT}`);
  console.log(`  Environment: ${process.env.SQUARE_ENVIRONMENT || 'sandbox'}`);
  console.log(`  Location:    ${LOCATION_ID}\n`);
});
