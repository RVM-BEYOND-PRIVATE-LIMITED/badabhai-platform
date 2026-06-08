import 'package:flutter/material.dart';

import '../../router.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Text('BadaBhai', style: TextStyle(fontSize: 32, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            const Text('Your placement bhai for factory jobs'),
            const SizedBox(height: 32),
            FilledButton(
              onPressed: () => Navigator.pushReplacementNamed(context, Routes.phoneLogin),
              child: const Text('Get started'),
            ),
          ],
        ),
      ),
    );
  }
}
