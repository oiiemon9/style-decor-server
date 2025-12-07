const express = require('express');
const app = express();
require('dotenv').config();
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const port = process.env.PORT || 3000;

//stripe payment gateway setup
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gj5u2pw.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const serviceAccount = require('./style-decor-firebase-adminsdk.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(cors());
app.use(express.json());

const verifyFireBaseToken = async (req, res, next) => {
  console.log(verifyFireBaseToken);
  if (!req.headers.authorization) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  const token = req.headers.authorization.split(' ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    next();
  } catch (error) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
};

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

async function run() {
  try {
    await client.connect();
    const db = client.db('styleDecor');
    const usersCollection = db.collection('users');
    const servicesCollection = db.collection('services');
    const bookingsCollection = db.collection('bookings');

    app.post('/users', async (req, res) => {
      const user = req.body;
      user.role = 'user';
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: 'User already exists' });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', async (req, res) => {
      const cursor = usersCollection.find();
      const users = await cursor.toArray();
      res.send(users);
    });

    app.patch('/users/:id', async (req, res) => {
      const id = req.params.id;
      const updatedUser = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: updatedUser.role,
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.delete('/users/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    });

    app.post('/service-upload', verifyFireBaseToken, async (req, res) => {
      const service = req.body;
      service.createdAt = new Date();
      const result = await servicesCollection.insertOne(service);
      res.send(result);
    });
    app.get('/services', async (req, res) => {
      const cursor = servicesCollection.find().sort({ createdAt: -1 });
      const services = await cursor.toArray();
      res.send(services);
    });

    app.get('/services/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const service = await servicesCollection.findOne(query);
      res.send(service);
    });

    // stripe payment
    app.post(
      '/create-checkout-session',
      verifyFireBaseToken,
      async (req, res) => {
        const serviceInfo = req.body;

        console.log(serviceInfo);

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: serviceInfo.serviceTitle,
                },
                unit_amount: serviceInfo.totalPrice * 100,
              },

              quantity: 1,
            },
          ],
          customer_email: serviceInfo.email,
          mode: 'payment',
          metadata: {
            name: serviceInfo.name,
            email: serviceInfo.email,
            location: serviceInfo.location,
            phone: serviceInfo.phone,
            note: serviceInfo.note,
            payment: serviceInfo.payment,
            serviceId: serviceInfo.serviceId,
            serviceTitle: serviceInfo.serviceTitle,
            quantity: serviceInfo.quantity,
            totalPrice: serviceInfo.totalPrice,
            paymentStatus: serviceInfo.paymentStatus,
            createdAt: new Date(),
          },
          success_url: `${process.env.DOMAIN_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.DOMAIN_URL}/payment-failed`,
        });
        res.send({ url: session.url });
      }
    );

    app.post('/payment-success', verifyFireBaseToken, async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session) {
        const bookingDetails = session.metadata;
        if (session.payment_status === 'paid') {
          bookingDetails.paymentStatus = session.payment_status;
        }
        bookingDetails.transactionId = session.payment_intent;
        const result = await bookingsCollection.insertOne(bookingDetails);
        res.send(result);
      }
    });

    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
