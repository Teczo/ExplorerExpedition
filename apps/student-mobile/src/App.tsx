import { SafeAreaView, StyleSheet, Text, View } from 'react-native';

/**
 * Student app shell.
 *
 * This is scaffold only. The real shell and join flow is EXPD-040.
 */
export function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>Explorer Expedition</Text>
        <Text style={styles.title}>Student App</Text>
        <Text style={styles.body}>
          Scaffold only. The app shell and join flow is EXPD-040.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#020617',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  eyebrow: {
    color: '#94a3b8',
    fontSize: 12,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  title: {
    color: '#f1f5f9',
    fontSize: 32,
    fontWeight: '600',
    marginTop: 8,
  },
  body: {
    color: '#cbd5e1',
    fontSize: 16,
    marginTop: 16,
  },
});
