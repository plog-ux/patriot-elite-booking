// ═══════════════════════════════════════════════════════════════════
// Patriot Elite Logistics — Unified Booking Server
// ═══════════════════════════════════════════════════════════════════
// This single server does everything:
//   - Serves the booking website (public/index.html)
//   - Handles card payments via Square
//   - Creates and sends Square invoices
//   - Manages customer records in Square
//   - Creates Google Calendar events for each booking
//
// Deploy to Railway, Render, or any Node.js host.
// ═══════════════════════════════════════════════════════════════════

require('dotenv').config();
const path     = require('path');
const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { Client, Environment } = require('square');
const { google } = require('googleapis');

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

// ── Google Calendar setup (optional) ──────────────────────────
// Uses OAuth2 with a refresh token so your booking@p-log.org
// calendar gets events automatically. If credentials aren't set,
// everything else still works normally.
let calendarClient = null;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'booking@p-log.org';

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });
    calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
    console.log('Google Calendar integration: ENABLED');
  } catch (err) {
    console.warn('Google Calendar setup failed (bookings will still work):', err.message);
  }
} else {
  console.log('Google Calendar integration: DISABLED (no credentials set)');
}

/**
 * Create a Google Calendar event for a new booking.
 * Silently skips if calendar isn't configured — never blocks a booking.
 */
async function createCalendarEvent({ service, date, time, pickup, dropoff, passengers, customerName, customerEmail, customerPhone, notes, confirmationId, paymentMethod }) {
  if (!calendarClient) return null;

  try {
    // Parse the booking date and time into a proper DateTime
    // date comes in as "March 25, 2026" or similar, time as "10:00 AM"
    const eventStart = parseBookingDateTime(date, time);
    if (!eventStart) {
      console.warn('Calendar: Could not parse date/time, skipping event creation.');
      return null;
    }

    // Default to 1-hour event (can be adjusted per service later)
    const eventEnd = new Date(eventStart.getTime() + 60 * 60 * 1000);

    const description = [
      `Confirmation: ${confirmationId}`,
      `Service: ${service}`,
      `Customer: ${customerName}`,
      `Email: ${customerEmail}`,
      customerPhone ? `Phone: ${customerPhone}` : null,
      `Passengers: ${passengers}`,
      `Pickup: ${pickup}`,
      `Dropoff: ${dropoff}`,
      notes ? `Notes: ${notes}` : null,
      `Payment: ${paymentMethod}`,
    ].filter(Boolean).join('\n');

    const event = {
      summary:     `${service} — ${customerName}`,
      location:    pickup || '',
      description: description,
      start: {
        dateTime: eventStart.toISOString(),
        timeZone: 'America/Phoenix',
      },
      end: {
        dateTime: eventEnd.toISOString(),
        timeZone: 'America/Phoenix',
      },
      // Color: Banana (yellow) to stand out as a booking
      colorId: '5',
    };

    const result = await calendarClient.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      resource: event,
    });

    console.log(`Calendar event created: ${result.data.htmlLink}`);
    return result.data.htmlLink;

  } catch (err) {
    // Never let a calendar error block a booking
    console.error('Calendar event creation failed (booking still succeeded):', err.message);
    return null;
  }
}

/**
 * Parse booking date + time strings into a JS Date.
 * Handles formats like "March 25, 2026" + "10:00 AM"
 */
function parseBookingDateTime(dateStr, timeStr) {
  try {
    if (!dateStr || !timeStr) return null;

    // Combine and let Date.parse handle it
    const combined = `${dateStr} ${timeStr}`;
    const d = new Date(combined);
    if (!isNaN(d.getTime())) return d;

    // Fallback: try ISO-style date + time
    const isoAttempt = new Date(`${dateStr}T${convertTo24Hour(timeStr)}`);
    if (!isNaN(isoAttempt.getTime())) return isoAttempt;

    return null;
  } catch {
    return null;
  }
}

/** Convert "10:00 AM" → "10:00" or "2:30 PM" → "14:30" */
function convertTo24Hour(timeStr) {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return timeStr;
  let hours = parseInt(match[1], 10);
  const mins = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  return `${String(hours).padStart(2, '0')}:${mins}`;
}


// ── Express app ────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve the booking website from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'patriot-elite-booking', calendar: !!calendarClient });
});


// ═══════════════════════════════════════════════════════════════
// Google Calendar OAuth2 — one-time setup endpoints
// Visit /api/google/auth to start, then save the refresh token.
// Remove these endpoints once you have your refresh token.
// ═══════════════════════════════════════════════════════════════
app.get('/api/google/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.send('<h2>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Railway first.</h2>');
  }

  // Build the redirect URI from the current request
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${protocol}://${host}/api/google/callback`;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
  });

  res.redirect(authUrl);
});

app.get('/api/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code.');

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${protocol}://${host}/api/google/callback`;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    res.send(`
      <html><body style="font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2 style="color: #4a9;">Google Calendar Connected!</h2>
        <p>Copy this refresh token and add it as <strong>GOOGLE_REFRESH_TOKEN</strong> in Railway:</p>
        <textarea style="width:100%; height:120px; font-family:monospace; font-size:13px; padding:10px;">${refreshToken}</textarea>
        <p style="color:#999; margin-top:16px;">After adding the variable to Railway, the server will restart and calendar events will be created automatically for new bookings.</p>
        <p style="color:#e55; margin-top:16px;"><strong>Security note:</strong> Once you've saved the token, you can remove the <code>/api/google/auth</code> and <code>/api/google/callback</code> endpoints from server.js.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send(`<h2>Error</h2><pre>${err.message}</pre>`);
  }
});


// ═══════════════════════════════════════════════════════════════
// GET /api/services
// Fetch services from your Square Catalog so the booking page
// always shows your current offerings and prices.
// ═══════════════════════════════════════════════════════════════
app.get('/api/services', async (_req, res) => {
  try {
    // Fetch ALL catalog items (ITEM covers both products and services)
    const allItems = [];

    // Fetch standard catalog items
    let cursor = undefined;
    do {
      const result = await catalogApi.listCatalog(cursor, 'ITEM');
      const objects = result.result.objects || [];
      allItems.push(...objects);
      cursor = result.result.cursor;
    } while (cursor);

    // Also try to fetch via Square Appointments (bookings) API
    // Square services from the Service Library use the catalog but
    // have itemData.productType === 'APPOINTMENTS_SERVICE'
    try {
      const searchResult = await catalogApi.searchCatalogItems({
        productTypes: ['APPOINTMENTS_SERVICE'],
      });
      const searchItems = searchResult.result.items || [];
      const existingIds = new Set(allItems.map(i => i.id));
      for (const item of searchItems) {
        if (!existingIds.has(item.id)) {
          allItems.push(item);
        }
      }
    } catch (searchErr) {
      console.log('Note: searchCatalogItems not available, using listCatalog only.');
    }

    // Map Square catalog items into a clean format for the frontend
    const services = allItems
      .filter(item => {
        const data = item.itemData;
        if (!data) return false;
        if (item.isDeleted) return false;
        return true;
      })
      .map(item => {
        const data = item.itemData;
        const variation = data.variations && data.variations[0];
        const priceMoney = variation?.itemVariationData?.priceMoney;
        const duration = variation?.itemVariationData?.serviceDuration;

        let priceCents = null;
        let priceDisplay = 'Custom Quote';
        let pricePerUnit = '';

        if (priceMoney && priceMoney.amount) {
          priceCents = Number(priceMoney.amount);
          const dollars = priceCents / 100;
          priceDisplay = '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: dollars % 1 ? 2 : 0 });
        }

        if (duration) {
          const minutes = Number(duration) / 60000;
          if (minutes >= 60) {
            pricePerUnit = `/ ${Math.round(minutes / 60)} hr`;
          } else {
            pricePerUnit = `/ ${Math.round(minutes)} min`;
          }
        }

        return {
          id:           item.id,
          variationId:  variation?.id || null,
          name:         data.name || 'Service',
          description:  data.description || data.descriptionPlaintext || '',
          priceCents:   priceCents,
          priceDisplay: priceDisplay,
          pricePerUnit: pricePerUnit,
          productType:  data.productType || 'REGULAR',
        };
      });

    console.log(`Catalog: found ${allItems.length} total items, ${services.length} active services`);
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
// Also creates a Google Calendar event for the booking.
// ═══════════════════════════════════════════════════════════════
app.post('/api/pay', async (req, res) => {
  try {
    const { sourceId, amountCents, customerId, booking, customer } = req.body;

    if (!sourceId || !amountCents) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceId and amountCents.',
      });
    }

    const bookingNote = booking
      ? `${booking.service} | ${booking.date} ${booking.time} | ${booking.pickup} → ${booking.dropoff} | ${booking.passengers} pax`
      : 'Patriot Elite Logistics booking';

    const confirmationId = 'PEL-' + Date.now().toString(36).toUpperCase();

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
      referenceId: confirmationId,
    });

    const payment = paymentResult.result.payment;

    // ── Create Google Calendar event (non-blocking) ──
    const calendarLink = await createCalendarEvent({
      service:       booking?.service || 'Transportation',
      date:          booking?.date,
      time:          booking?.time,
      pickup:        booking?.pickup || '',
      dropoff:       booking?.dropoff || '',
      passengers:    booking?.passengers || '1',
      customerName:  customer?.name || 'Customer',
      customerEmail: customer?.email || '',
      customerPhone: customer?.phone || '',
      notes:         booking?.notes || '',
      confirmationId,
      paymentMethod: 'Card payment',
    });

    res.json({
      success:        true,
      paymentId:      payment.id,
      status:         payment.status,
      receiptUrl:     payment.receiptUrl,
      confirmationId: confirmationId,
      calendarLink:   calendarLink,
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
// customer's email. Also creates a Google Calendar event.
// ═══════════════════════════════════════════════════════════════
app.post('/api/invoice', async (req, res) => {
  try {
    const { customerId, amountCents, serviceName, booking, email, customer } = req.body;

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
    const confirmationId = 'PEL-' + Date.now().toString(36).toUpperCase();

    // ── Create Google Calendar event (non-blocking) ──
    const calendarLink = await createCalendarEvent({
      service:       serviceName || 'Transportation',
      date:          booking?.date,
      time:          booking?.time,
      pickup:        booking?.pickup || '',
      dropoff:       booking?.dropoff || '',
      passengers:    booking?.passengers || '1',
      customerName:  customer?.name || 'Customer',
      customerEmail: customer?.email || '',
      customerPhone: customer?.phone || '',
      notes:         booking?.notes || '',
      confirmationId,
      paymentMethod: 'Invoice — ' + (publishedInvoice.publicUrl || 'pending'),
    });

    res.json({
      success:        true,
      invoiceId:      publishedInvoice.id,
      invoiceNumber:  publishedInvoice.invoiceNumber,
      status:         publishedInvoice.status,
      publicUrl:      publishedInvoice.publicUrl,
      confirmationId: confirmationId,
      calendarLink:   calendarLink,
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
  console.log(`  Location:    ${LOCATION_ID}`);
  console.log(`  Calendar:    ${calendarClient ? GOOGLE_CALENDAR_ID : 'not configured'}\n`);
});
